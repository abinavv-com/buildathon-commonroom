// Run one Commonroom agent as its own process, talking to the server over the public API only.
//   node agents/run.mjs tidy            executor: claims open jobs it can do and does the ones assigned to it
//   node agents/run.mjs quickleads --lie   executor that pads its delivery (the server's checks should catch it)
//   node agents/run.mjs crosscheck      verifier: re-derives each result and attests to the hash it got
//   node agents/run.mjs scout           neither: prints its /v1/home check-in and exits
// Key: COMMONROOM_KEY, or the seeded key for <handle> from .data/agent-keys.json (COMMONROOM_DATA overrides .data).
// Server: COMMONROOM_URL (default http://localhost:3000).
// Note: server.mjs already runs the seeded agents in-process. Start it with COMMONROOM_AGENTS=off if you want
// these external processes to be the only ones doing the work.
import fs from "node:fs";
import path from "node:path";
import { client, doTask, audit } from "./lib.mjs";

const handle = process.argv[2];
const lie = process.argv.includes("--lie");
if (!handle || handle.startsWith("-")) {
  console.error("Usage: node agents/run.mjs <handle> [--lie]");
  process.exit(2);
}
const BASE = (process.env.COMMONROOM_URL || "http://localhost:3000").replace(/\/+$/, "");
const KEYFILE = path.join(process.env.COMMONROOM_DATA || path.join(import.meta.dirname, "..", ".data"), "agent-keys.json");
let KEY = process.env.COMMONROOM_KEY;
if (!KEY) {
  try { KEY = JSON.parse(fs.readFileSync(KEYFILE, "utf8"))[handle]; } catch {}
  if (!KEY) { console.error(`No key: set COMMONROOM_KEY, or start the server once so ${KEYFILE} has @${handle}.`); process.exit(2); }
}

const api = client(BASE, KEY);
const say = (msg) => console.log(`[@${handle}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (e) => e.status === 409; // someone else got there first: normal when several agents run

async function executorTick(scopes) {
  const home = await api("GET", "/v1/home");
  if (scopes.includes("jobs:execute") && !lie) {
    for (const j of home.jobs_you_can_claim.slice(0, 1)) {
      await api("POST", `/v1/jobs/${j.id}/claim`);
      say(`claimed ${j.id}: ${j.task}`);
    }
  }
  for (const { id } of home.jobs_assigned_to_you.slice(0, 1)) {
    const job = await api("GET", `/v1/jobs/${id}`);
    const r = doTask(job, { lie });
    const done = await api("POST", `/v1/jobs/${id}/result`, r);
    const failed = done.checks.filter((c) => !c.passed).map((c) => c.label);
    say(`${id}: submitted "${r.claim ?? "done"}" -> ${done.status}${failed.length ? ` (failed: ${failed.join("; ")})` : ""}`);
  }
}

async function verifierTick() {
  const home = await api("GET", "/v1/home");
  for (const { id } of home.jobs_you_can_verify.slice(0, 1)) {
    const job = await api("GET", `/v1/jobs/${id}`);
    const v = audit(job);
    const done = await api("POST", `/v1/jobs/${id}/verdicts`, v);
    say(`${id}: ${v.verdict} (${v.note}) -> ${done.status}`);
  }
}

const me = await api("GET", "/v1/me");
if (me.type !== "agent") { console.error("That key isn't an agent key."); process.exit(2); }
const caps = me.agent.capabilities.map((c) => c.name);
const tick = caps.includes("csv.dedupe") || caps.includes("leads.extract") ? () => executorTick(me.scopes)
  : caps.includes("jobs.verify") ? verifierTick : null;

if (!tick) {
  console.log(JSON.stringify(await api("GET", "/v1/home"), null, 2));
  process.exit(0);
}
say(`${me.agent.status}; offers ${caps.join(", ")}; scopes ${me.scopes.join(", ") || "none"}${lie ? "; LYING mode" : ""}. Checking in every 2s.`);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  try { await tick(); } catch (e) { if (!quiet(e)) say(`error: ${e.message}${e.code ? ` (${e.code})` : ""}`); }
  await sleep(2000);
}
