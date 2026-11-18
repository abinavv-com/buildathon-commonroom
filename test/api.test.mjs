// Spawns a real server on a temp data dir and checks the trust rules end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dedupe } from "../lib/csv.mjs";

const PORT = 3977;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "commonroom-"));
const srv = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT, COMMONROOM_DATA: DATA } });
await new Promise((r) => srv.stdout.once("data", r));
test.after(() => srv.kill());
const T = JSON.parse(fs.readFileSync(path.join(DATA, "tokens.json"), "utf8"));

async function api(who, method, p, body) {
  const res = await fetch(`http://localhost:${PORT}${p}`, { method, body: body && JSON.stringify(body), headers: { authorization: `Bearer ${T[who]}` } });
  return { ...(await res.json()), http: res.status };
}
const CSV = "url,t\na,1\nA/,2\nb,3";
const hire = (who = "scout", n = 2) => api(who, "POST", "/api/jobs", { executor: "tidy", csv: CSV, key_column: "url", verifiers_required: n });
const honest = dedupe(CSV, "url");

test("honest job passes both gates and publishes", async () => {
  const j = await hire();
  assert.equal((await api("tidy", "POST", `/api/jobs/${j.id}/result`, honest)).http, 200);
  await api("crosscheck", "POST", `/api/jobs/${j.id}/verdicts`, { verdict: "pass", sha256: honest.sha256 });
  const done = await api("recount", "POST", `/api/jobs/${j.id}/verdicts`, { verdict: "pass", sha256: honest.sha256 });
  assert.equal(done.status, "succeeded");
  assert.equal((await api("scout", "POST", `/api/jobs/${j.id}/publish`)).kind, "completed");
});

test("tampered output fails gate 1", async () => {
  const j = await hire();
  const r = await api("tidy", "POST", `/api/jobs/${j.id}/result`, { ...honest, output_csv: "url,t\na,1" });
  assert.equal(r.status, "failed");
});

test("a pass whose hash doesn't match counts as a fail", async () => {
  const j = await hire();
  await api("tidy", "POST", `/api/jobs/${j.id}/result`, honest);
  const r = await api("crosscheck", "POST", `/api/jobs/${j.id}/verdicts`, { verdict: "pass", sha256: "0".repeat(64) });
  assert.equal(r.status, "failed");
});

test("a verifier owned by the requester's side is refused", async () => {
  const j = await hire("desk", 1); // @desk owns @crosscheck, so crosscheck isn't independent of this job
  await api("tidy", "POST", `/api/jobs/${j.id}/result`, honest);
  assert.equal((await api("crosscheck", "POST", `/api/jobs/${j.id}/verdicts`, { verdict: "pass", sha256: honest.sha256 })).http, 403);
});

test("removing a scope blocks the write; only the owner can change scopes", async () => {
  assert.equal((await api("desk", "PUT", "/api/agents/scout/scopes", { scopes: [] })).http, 403);
  assert.equal((await api("you", "PUT", "/api/agents/scout/scopes", { scopes: ["posts:write"] })).http, 200);
  assert.equal((await hire()).http, 403);
  await api("you", "PUT", "/api/agents/scout/scopes", { scopes: ["posts:write", "jobs:create"] });
  assert.equal((await hire()).http, 200);
});
