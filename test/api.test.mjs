// Spawns a real server (demo agents off, temp data) and walks the trust and money rules end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doTask, audit } from "../agents/lib.mjs";
import { SAMPLE_SOURCE } from "../lib/leads.mjs";

const PORT = 3977;
const B = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "commonroom-"));
const srv = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT, COMMONROOM_DATA: DATA, COMMONROOM_AGENTS: "off" } });
await new Promise((r) => srv.stdout.once("data", r));
test.after(() => srv.kill());
const K = JSON.parse(fs.readFileSync(path.join(DATA, "agent-keys.json"), "utf8"));

async function api(who, method, p, body, headers = {}) {
  const auth = who.startsWith("cr_session=") ? { cookie: who } : { authorization: `Bearer ${K[who]}` };
  const res = await fetch(B + p, { method, body: body && JSON.stringify(body), headers: { "content-type": "application/json", ...auth, ...headers } });
  return { ...(await res.json()), http: res.status };
}
async function guest() {
  const res = await fetch(`${B}/v1/auth/guest`, { method: "POST", headers: { "content-type": "application/json" } });
  return res.headers.get("set-cookie").split(";")[0];
}
const LEADS = { capability: "leads.extract", inputs: { source_csv: SAMPLE_SOURCE, title_includes: "growth", count: 5 }, verifiers_required: 2 };
const wallet = async (who) => (await api(who, "GET", "/v1/wallet")).available;

test("honest job: escrow, both gates, payout, signed receipt, private data stays private", async () => {
  const me = await guest();
  const before = await wallet(me);
  const j = await api(me, "POST", "/v1/jobs", { ...LEADS, executor: "prospector" });
  assert.equal(j.http, 200);
  assert.equal(await wallet(me), before - j.hold);
  const full = await api("prospector", "GET", `/v1/jobs/${j.id}`);
  const after1 = await api("prospector", "POST", `/v1/jobs/${j.id}/result`, doTask(full));
  assert.equal(after1.status, "verifying");
  assert.deepEqual(new Set(after1.verifiers), new Set(["crosscheck", "recount"]));
  for (const v of after1.verifiers) await api(v, "POST", `/v1/jobs/${j.id}/verdicts`, audit(await api(v, "GET", `/v1/jobs/${j.id}`)));
  const done = await api(me, "GET", `/v1/jobs/${j.id}`);
  assert.equal(done.status, "succeeded");
  assert.equal(await wallet(me), before - j.price - 2 * j.verifier_fee); // price + two verifier fees, nothing more
  const r = await (await fetch(`${B}/v1/receipts/${done.receipt_id}`)).json();
  assert.equal((await api(me, "POST", "/v1/receipts/verify", { receipt: r.receipt, signature: r.signature })).valid, true);
  r.receipt.payment.price += 1;
  assert.equal((await api(me, "POST", "/v1/receipts/verify", { receipt: r.receipt, signature: r.signature })).valid, false);
  const anon = await (await fetch(`${B}/v1/jobs/${j.id}`)).json();
  assert.equal(anon.inputs, null);
  assert.equal(anon.result.output_csv, undefined);
});

test("a lying agent is caught at gate 1 and the payer is refunded in full", async () => {
  const me = await guest();
  const before = await wallet(me);
  const j = await api(me, "POST", "/v1/jobs", { ...LEADS, executor: "quickleads" });
  const r = await api("quickleads", "POST", `/v1/jobs/${j.id}/result`, doTask(await api("quickleads", "GET", `/v1/jobs/${j.id}`), { lie: true }));
  assert.equal(r.status, "failed");
  assert.ok(r.checks.some((c) => c.label === "Every lead exists in the source list" && !c.passed));
  assert.equal(await wallet(me), before);
});

test("only the assigned roster can read or vote; a pass can't contain a failed check", async () => {
  const me = await guest();
  const owner = await guest();
  const extra = await api(owner, "POST", "/v1/agents", { handle: `v${Date.now() % 1e6}`, name: "Extra verifier", capabilities: [{ name: "jobs.verify" }], scopes: ["jobs:verify"] });
  K.extra = extra.api_key;
  const j = await api(me, "POST", "/v1/jobs", { ...LEADS, executor: "prospector", verifiers_required: 1 });
  const v = await api("prospector", "POST", `/v1/jobs/${j.id}/result`, doTask(await api("prospector", "GET", `/v1/jobs/${j.id}`)));
  const outsider = v.verifiers.includes(extra.agent.handle) ? "crosscheck" : "extra";
  assert.equal((await api(outsider, "GET", `/v1/jobs/${j.id}`)).inputs, null);
  assert.equal((await api(outsider, "POST", `/v1/jobs/${j.id}/verdicts`, { verdict: "fail", sha256: "0".repeat(64) })).http, 403);
  const assigned = v.verifiers[0] === extra.agent.handle ? "extra" : v.verifiers[0];
  const bad = await api(assigned, "POST", `/v1/jobs/${j.id}/verdicts`, { verdict: "pass", sha256: v.result.sha256, checks: [{ label: "x", passed: false }] });
  assert.equal(bad.error.code, "inconsistent_verdict");
});

test("dedupe verifiers work blind: they can't see the executor's answer before voting", async () => {
  const me = await guest();
  const j = await api(me, "POST", "/v1/jobs", { capability: "csv.dedupe", executor: "tidy", inputs: { csv: "k\na\nA\nb", key_column: "k" }, verifiers_required: 1 });
  const v = await api("tidy", "POST", `/v1/jobs/${j.id}/result`, doTask(await api("tidy", "GET", `/v1/jobs/${j.id}`)));
  const seen = await api(v.verifiers[0], "GET", `/v1/jobs/${j.id}`);
  assert.equal(seen.result, null);
  assert.ok(seen.inputs.csv);
  assert.equal((await api(v.verifiers[0], "POST", `/v1/jobs/${j.id}/verdicts`, audit(seen))).status, "succeeded");
});

test("the permission layer: keys can't leave, agents can't grant themselves scopes", async () => {
  const posts = await (await fetch(`${B}/v1/posts`)).json();
  const leak = await api("prospector", "POST", `/v1/posts/${posts[0].id}/comments`, { body: `my key: ${K.prospector}` });
  assert.equal(leak.error.code, "secret_blocked");
  assert.equal((await api("prospector", "PATCH", "/v1/agents/prospector", { scopes: ["jobs:verify"] })).http, 403);
  assert.ok((await (await fetch(`${B}/v1/analytics`)).json()).totals.blocked >= 2);
  assert.equal((await fetch(`${B}/v1/activity`)).status, 401); // the activity log is private
});

test("money and session rules: funds, self-dealing, cross-site cookies", async () => {
  const me = await guest();
  assert.equal((await api(me, "POST", "/v1/jobs", { ...LEADS, budget: 100000 })).error.code, "insufficient_funds");
  const mine = await api(me, "POST", "/v1/agents", { handle: `m${Date.now() % 1e6}`, name: "Mine", capabilities: [{ name: "leads.extract", price: 100 }] });
  assert.equal((await api(me, "POST", "/v1/jobs", { ...LEADS, executor: mine.agent.handle })).error.code, "self_dealing");
  assert.equal((await api(me, "POST", "/v1/wallet/topup", { amount: 500 }, { origin: "https://evil.example" })).error.code, "bad_origin");
});
