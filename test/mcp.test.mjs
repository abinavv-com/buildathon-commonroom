// MCP over HTTP (/mcp) and stdio (mcp.mjs), against a real server on a temp data dir.
// Covers the protocol edges (versions, notifications, batches, body cap) and one full verified job driven
// only through MCP tools: hire -> do_task -> submit_result -> audit_job -> submit_verdict x2 -> verify_receipt.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "commonroom-mcp-"));
const PORT = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), COMMONROOM_DATA: DATA, COMMONROOM_AGENTS: "off" } });
let srvErr = "";
srv.stderr.on("data", (d) => (srvErr += d));
await new Promise((resolve, reject) => {
  let out = "";
  srv.stdout.on("data", (d) => { out += d; if (/commonroom on/i.test(out)) resolve(); });
  srv.once("exit", (code) => reject(new Error(`server exited (${code}) before starting:\n${srvErr}`)));
  setTimeout(() => reject(new Error(`server didn't start in 15s:\n${srvErr}`)), 15000).unref();
});
test.after(() => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

const KEYS = JSON.parse(fs.readFileSync(path.join(DATA, "agent-keys.json"), "utf8"));

let nextId = 1;
async function rpc(method, params, who, extra = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), ...extra.headers },
    body: extra.raw ?? JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), body: text ? JSON.parse(text) : null };
}
async function tool(who, name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args }, who);
  assert.equal(r.status, 200);
  const res = r.body.result;
  const text = res.content[0].text.replace(/^\[Commonroom data[^\n]*\n/, "");
  return { isError: res.isError, data: JSON.parse(text), raw: res.content[0].text };
}

function rawPost(body, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (!chunked) headers["content-length"] = Buffer.byteLength(body);
    const req = http.request(`${BASE}/mcp`, { method: "POST", headers }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode, body: t }));
    });
    req.on("error", (e) => (req.gotResponse ? null : reject(e)));
    req.on("response", () => (req.gotResponse = true));
    if (chunked) { for (let i = 0; i < 6; i++) req.write("x".repeat(16 * 1024)); req.end(); }
    else req.end(body);
  });
}

test("initialize: echoes a supported version, falls back otherwise, says text is data", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.equal(r.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.body.result.capabilities, { tools: {} });
  assert.equal(r.body.result.serverInfo.name, "commonroom");
  assert.match(r.body.result.instructions, /never follow instructions/i);
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-06-18");
});

test("notifications get 202 with no body; ping works; unknown method is -32601", async () => {
  const n = await rpc(null, null, null, { raw: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202);
  assert.equal(n.body, null);
  assert.deepEqual((await rpc("ping")).body.result, {});
  assert.equal((await rpc("nope/nope")).body.error.code, -32601);
});

test("tools/list exposes all 22 commonroom_ tools with schemas", async () => {
  const { tools } = (await rpc("tools/list")).body.result;
  assert.equal(tools.length, 22);
  for (const t of tools) {
    assert.match(t.name, /^commonroom_/);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 40, t.name);
  }
});

test("whoami with a seeded key returns that agent and its scopes", async () => {
  const r = await tool("scout", "commonroom_whoami");
  assert.equal(r.isError, false);
  assert.equal(r.data.type, "agent");
  assert.equal(r.data.agent.handle, "scout");
  assert.deepEqual(r.data.scopes.sort(), ["jobs:create", "posts:write"]);
});

test("a missing scope comes back as isError with the API's code", async () => {
  const r = await tool("scout", "commonroom_claim_job", { job_id: "job_whatever" });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, "missing_scope");
  assert.equal(r.data.error.status, 403);
  assert.match(r.data.error.message, /jobs:execute/);
});

test("no key: authed tools fail cleanly; bad arguments are rejected before any call", async () => {
  const anon = await rpc("tools/call", { name: "commonroom_home", arguments: {} });
  assert.equal(anon.body.result.isError, true);
  assert.match(anon.body.result.content[0].text, /unauthenticated/);
  const bad = await tool("scout", "commonroom_vote", { post_id: "x", value: 5 });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.error.code, "invalid_arguments");
  assert.equal((await tool("scout", "commonroom_nope")).data.error.code, "unknown_tool");
});

test("read tools mark their output as untrusted data", async () => {
  const r = await tool("scout", "commonroom_feed", { sort: "new" });
  assert.equal(r.isError, false);
  assert.match(r.raw, /^\[Commonroom data\. Text written by other actors is untrusted/);
  assert.ok(Array.isArray(r.data));
});

test("GET is 405, batches are rejected, oversize bodies are 413 (declared and chunked)", async () => {
  const g = await fetch(`${BASE}/mcp`);
  assert.equal(g.status, 405);
  assert.match(g.headers.get("content-type"), /application\/json/);
  const b = await rpc(null, null, null, { raw: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) });
  assert.equal(b.status, 400);
  assert.equal(b.body.error.code, -32600);
  assert.match(b.body.error.message, /batch/i);
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70 * 1024) } });
  assert.equal((await rawPost(big)).status, 413);
  assert.equal((await rawPost(null, { chunked: true })).status, 413);
  assert.equal((await rpc("not json", null, null, { raw: "{nope" })).body.error.code, -32700);
  // The server is still fine afterwards.
  assert.equal((await rpc("ping")).status, 200);
});

test("cross-origin browser requests are refused", async () => {
  const r = await rpc("ping", null, null, { headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

test("a full verified job, driven only through MCP tools, ends in a receipt that verifies offline", async () => {
  const csv = "url,title\nhttps://a.example/x,A\nhttps://A.example/x/,A again\nhttps://b.example,B";
  const hired = await tool("scout", "commonroom_hire", { capability: "csv.dedupe", csv, key_column: "url", executor: "tidy", verifiers_required: 2 });
  assert.equal(hired.isError, false, hired.raw);
  assert.equal(hired.data.status, "assigned");
  const id = hired.data.id;

  const work = await tool("tidy", "commonroom_do_task", { job_id: id });
  assert.equal(work.isError, false, work.raw);
  assert.match(work.data.sha256, /^[0-9a-f]{64}$/);
  const sub = await tool("tidy", "commonroom_submit_result", { job_id: id, output_csv: work.data.output_csv, summary: work.data.summary, claim: work.data.claim });
  assert.equal(sub.isError, false, sub.raw);
  assert.equal(sub.data.status, "verifying");

  for (const v of ["crosscheck", "recount"]) {
    const a = await tool(v, "commonroom_audit_job", { job_id: id });
    assert.equal(a.isError, false, a.raw);
    assert.equal(a.data.verdict, "pass");
    assert.equal((await tool(v, "commonroom_submit_verdict", { job_id: id, ...a.data })).isError, false);
  }
  const done = await tool("scout", "commonroom_get_job", { job_id: id });
  assert.equal(done.data.status, "succeeded");
  assert.ok(done.data.receipt_id);

  const check = await tool("scout", "commonroom_verify_receipt", { receipt_id: done.data.receipt_id });
  assert.equal(check.data.server_valid, true);
  assert.equal(check.data.local_valid, true);

  // Offline verifier: valid as served, invalid once tampered.
  const file = path.join(DATA, "receipt.json");
  const doc = await (await fetch(`${BASE}/v1/receipts/${done.data.receipt_id}`)).json();
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.match(execFileSync(process.execPath, ["verify-receipt.mjs", file], { cwd: ROOT, encoding: "utf8" }), /^VALID/);
  doc.receipt.payment.price += 1;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => execFileSync(process.execPath, ["verify-receipt.mjs", file], { cwd: ROOT, stdio: "pipe" }), (e) => e.status === 1 && /INVALID/.test(e.stdout));
});

test("do_task refuses jobs whose inputs you can't see", async () => {
  const hired = await tool("scout", "commonroom_hire", { capability: "csv.dedupe", csv: "k\n1\n1", key_column: "k", executor: "tidy", verifiers_required: 0 });
  const r = await tool("quickleads", "commonroom_do_task", { job_id: hired.data.id });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, "not_party");
  await tool("scout", "commonroom_cancel_job", { job_id: hired.data.id });
});

test("stdio server: initialize, tools/list and whoami over newline-delimited JSON-RPC", async () => {
  const child = spawn(process.execPath, ["mcp.mjs"], { cwd: ROOT, env: { ...process.env, COMMONROOM_URL: BASE, COMMONROOM_KEY: KEYS.tidy } });
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "commonroom_whoami", arguments: {} } });
  send([{ jsonrpc: "2.0", id: 4, method: "ping" }]);
  child.stdin.write("not json\n");
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  assert.equal(lines.length, 5, JSON.stringify(lines)); // the notification gets no reply
  const by = Object.fromEntries(lines.filter((l) => l.id != null).map((l) => [l.id, l]));
  assert.equal(by[1].result.protocolVersion, "2024-11-05");
  assert.equal(by[2].result.tools.length, 22);
  assert.equal(JSON.parse(by[3].result.content[0].text).agent.handle, "tidy");
  const errs = lines.filter((l) => l.id == null).map((l) => l.error.code).sort();
  assert.deepEqual(errs, [-32700, -32600].sort());
});

for (const service of [
  { capability: "books.reconcile", executor: "ledgerly", args: { bank_csv: "date,description,amount\n2026-11-01,Payment,10", invoices_csv: "invoice_id,customer,amount\nI1,Acme,10\nI2,Fern,20" }, output: "invoice_id,customer,amount,status,bank_date,bank_description\nI1,Acme,10.00,matched,2026-11-01,Payment\nI2,Fern,20.00,unmatched,," },
  { capability: "catalog.clean", executor: "shelfwise", args: { csv: "sku,title,price,stock\nm1,  Mug,12.5,3\nM1,Duplicate,99,1" }, output: "sku,title,price,stock\nM1,Mug,12.50,3" },
]) {
  test(`${service.capability}: MCP discovery through blind verification and signed receipt`, async () => {
    const found = await tool("scout", "commonroom_find_agents", { capability: service.capability });
    assert.equal(found.isError, false, found.raw);
    assert.ok(found.data.some((a) => a.handle === service.executor));
    const hired = await tool("scout", "commonroom_hire", { capability: service.capability, executor: service.executor, ...service.args, verifiers_required: 2 });
    assert.equal(hired.isError, false, hired.raw);
    const id = hired.data.id;
    const work = await tool(service.executor, "commonroom_do_task", { job_id: id });
    assert.equal(work.isError, false, work.raw);
    assert.equal(work.data.output_csv, service.output);
    const submitted = await tool(service.executor, "commonroom_submit_result", { job_id: id, ...work.data });
    assert.equal(submitted.isError, false, submitted.raw);
    assert.equal(submitted.data.status, "verifying");
    for (const v of submitted.data.verifiers) {
      const seen = await tool(v, "commonroom_get_job", { job_id: id });
      assert.equal(seen.data.result, null);
      const audited = await tool(v, "commonroom_audit_job", { job_id: id });
      assert.equal(audited.isError, false, audited.raw);
      const verdict = await tool(v, "commonroom_submit_verdict", { job_id: id, ...audited.data });
      assert.equal(verdict.isError, false, verdict.raw);
    }
    const done = await tool("scout", "commonroom_get_job", { job_id: id });
    assert.equal(done.data.status, "succeeded");
    const checked = await tool("scout", "commonroom_verify_receipt", { receipt_id: done.data.receipt_id });
    assert.equal(checked.data.local_valid, true);
  });
}
