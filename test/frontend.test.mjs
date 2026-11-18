// Frontend delivery checks against a real, isolated backend. No visual-layout claim.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildJobRequest } from "../public/contracts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "commonroom-frontend-"));
const PORT = await new Promise((resolve, reject) => {
  const server = net.createServer().listen(0, () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
  server.on("error", reject);
});
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), COMMONROOM_DATA: DATA, COMMONROOM_AGENTS: "off" } });
let errors = "";
child.stderr.on("data", chunk => { errors += chunk; });
await new Promise((resolve, reject) => {
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; if (/CommonRoom on/.test(output)) resolve(); });
  child.once("exit", code => reject(new Error(`Server exited ${code}: ${errors}`)));
  setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 15000).unref();
});
test.after(async () => {
  if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); }
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(DATA).startsWith(tempRoot));
  fs.rmSync(DATA, { recursive: true, force: true });
});

test("all browser entry assets have executable JavaScript or stylesheet MIME", async () => {
  for (const [file, type] of [["app.js", /javascript/], ["contracts.js", /javascript/], ["illustrations.js", /javascript/], ["app.css", /text\/css/]]) {
    const response = await fetch(`${BASE}/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type"), type, file);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.doesNotMatch(await response.text(), /^\s*<!doctype html/i, file);
    if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", path.join(ROOT, "public", file)], { stdio: "pipe" });
  }
});

test("real page URLs serve the supplied frontend shell and external scripts under CSP", async () => {
  const index = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  for (const route of ["/", "/agents", "/discover", "/dashboard", "/jobs", "/jobs/job_smoke", "/agent/tidy", "/hire/ledgerly/books.reconcile", "/receipts/rcpt_smoke", "/claim/smoke", "/login", "/signup", "/account"]) {
    const response = await fetch(BASE + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type"), /text\/html/, route);
    assert.equal(await response.text(), index, route);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  }
  const scriptTags = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scriptTags.length >= 2);
  for (const [, attrs, body] of scriptTags) {
    assert.match(attrs, /src=["'][^"']+["']/);
    assert.equal(body.trim(), "", "Inline scripts would be blocked by the current CSP");
  }
});

test("frontend request builders can hire all five advertised services through the real API", async () => {
  const response = await fetch(`${BASE}/v1/auth/guest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const caps = await (await fetch(`${BASE}/v1/capabilities`)).json();
  const executors = { "csv.to_json": "shift", "csv.dedupe": "tidy", "leads.extract": "prospector", "books.reconcile": "ledgerly", "catalog.clean": "shelfwise" };
  for (const [capability, executor] of Object.entries(executors)) {
    const cap = caps.find(item => item.name === capability);
    assert.ok(cap, capability);
    const body = buildJobRequest(capability, executor, { ...cap.sample_inputs, verifiers_required: "0" });
    const hired = await fetch(`${BASE}/v1/jobs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const job = await hired.json();
    assert.equal(hired.status, 200, JSON.stringify(job));
    assert.equal(job.capability, capability);
    assert.equal(job.status, "assigned");
    const cancelled = await fetch(`${BASE}/v1/jobs/${job.id}/cancel`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, "cancelled");
  }
});
