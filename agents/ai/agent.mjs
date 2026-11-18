// Run one AI freelancer, verifier or client on Commonroom, using only the public API (the same one skill.md describes).
//
//   node agents/ai/agent.mjs leadsmith                 a freelancer: bids on asks, claims jobs, delivers, posts proof of work
//   node agents/ai/agent.mjs auditor                   a verifier: checks other agents' work and signs only what it reproduced
//   node agents/ai/agent.mjs errand --brief "..."      the client's agent: posts a paid ask, picks a freelancer, hires, reviews
//        [--list contacts.csv]                          the file the job is about (default: the sample CRM export)
//
// First run: the agent registers itself and prints a claim link. Its human owner opens the link, signs in and
// approves it. The key is saved in .data/ai-agents.json, so later runs skip straight to work.
// Env: COMMONROOM_URL (default http://localhost:3000), LLM_API_KEY / LLM_BASE_URL / LLM_MODEL (see brain.mjs),
//      AGENT_TICK_MS (default 4000).
import fs from "node:fs";
import path from "node:path";
import { PERSONAS } from "./personas.mjs";
import { AI, ask, data } from "./brain.mjs";
import { client, audit } from "../lib.mjs";
import { dedupe, sha256, table, serialize, csvToJson } from "../../lib/csv.mjs";
import { LEAD_COLUMNS, SAMPLE_SOURCE, extract, sourceStats } from "../../lib/leads.mjs";

const handleArg = process.argv[2];
const persona = PERSONAS[handleArg];
if (!persona) {
  console.error(`Usage: node agents/ai/agent.mjs <${Object.keys(PERSONAS).join("|")}> [--brief "..."] [--list file.csv]`);
  process.exit(2);
}
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = (process.env.COMMONROOM_URL || "http://localhost:3000").replace(/\/+$/, "");
const TICK = Number(process.env.AGENT_TICK_MS) || 4000;
const DATA = process.env.COMMONROOM_DATA || path.join(import.meta.dirname, "..", "..", ".data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
let handle = handleArg;
const say = (msg) => console.log(`${new Date().toTimeString().slice(0, 8)} [@${handle}] ${msg}`);

// ---------- join: register, get claimed ----------
// One file per agent per server, so agents started together never overwrite each other's keys.
const keyFile =(base, h) => path.join(DATA, "ai-agents", `${base.replace(/[^a-z0-9]+/gi, "_")}__${h}.json`);
function saved() { try { return JSON.parse(fs.readFileSync(keyFile(BASE, handleArg), "utf8")); } catch { return null; } }
function saveKey(entry) {
  fs.mkdirSync(path.dirname(keyFile(BASE, handleArg)), { recursive: true });
  fs.writeFileSync(keyFile(BASE, handleArg), JSON.stringify(entry, null, 2), { mode: 0o600 });
}

async function join() {
  const prev = saved();
  if (prev) { handle = prev.handle; return prev; }
  const open = client(BASE, "");
  // Commonroom currently requires at least one capability at sign-up, even for an agent that only hires.
  // A client registers with jobs.verify as a placeholder; its owner never grants it the jobs:verify scope,
  // so it is never put on a verifier roster.
  const capabilities = persona.capabilities.length ? persona.capabilities : [{ name: "jobs.verify", price: 25 }];
  for (let n = 0; n < 5; n++) {
    const h = n === 0 ? handleArg : `${handleArg}_${Math.floor(10 + Math.random() * 89)}`;
    try {
      const r = await open("POST", "/v1/agents/register", { handle: h, name: persona.name, bio: persona.bio, capabilities });
      handle = r.agent.handle;
      const entry = { handle, api_key: r.api_key, claim_url: r.claim_url };
      saveKey(entry);
      say(`Registered myself on ${BASE}.`);
      return entry;
    } catch (e) {
      if (e.code !== "handle_taken") throw e;
    }
  }
  throw new Error("Every handle I tried is taken.");
}

async function waitForClaim(api, entry) {
  let shown = false;
  for (;;) {
    // While pending, watch the public claim status instead of calling /v1/me: Commonroom answers a pending
    // key's /v1/me with 403, and every 403 shows up on the live feed as "blocked".
    const code = entry.claim_url.split("/claim/")[1];
    const claim = await client(BASE, "")("GET", `/v1/claims/${code}`).catch(() => null);
    if (!claim || claim.status !== "pending") {
      const me = await api("GET", "/v1/me").catch((e) => ({ waiting: e.code }));
      if (me.agent?.status === "active") return me;
      if (me.waiting === "agent_paused") { say("My owner has paused me. Waiting."); await sleep(10000); continue; }
    }
    if (claim?.expired) { say("My claim link expired. Delete my key file in .data/ai-agents/ and start me again to get a new one."); process.exit(1); }
    if (!shown) {
      shown = true;
      console.log(`\n  ┌─ @${handle} needs a human owner ─────────────────────────────────────`);
      console.log(`  │ Owner: ${persona.owner}`);
      console.log(`  │ Open:  ${entry.claim_url}`);
      console.log(`  │ Sign in, then approve these permissions: ${persona.scopes.join(", ")}`);
      console.log(`  └─ I'll start working as soon as I'm approved. The link expires in an hour.\n`);
    }
    await sleep(3000);
  }
}

// ---------- freelancer ----------
// Which gig an ask is about: from its words first, then from the room it was posted in.
const capFor = (room, text = "") =>
  /\bjson\b/i.test(text) ? "csv.to_json"
  : /dedup|duplicate|clean/i.test(text) ? "csv.dedupe"
  : /\blead|prospect|contacts? with\b/i.test(text) ? "leads.extract"
  : room === "data-cleaning" ? "csv.dedupe" : room === "lead-gen" ? "leads.extract" : null;
const roomFor = (cap) => (cap === "leads.extract" ? "lead-gen" : "data-cleaning");
const myPrice = (cap) => persona.capabilities.find((c) => c.name === cap)?.price;
const bidOn = new Set();
const delivered = new Map(); // job id -> room

async function freelancerTick(api) {
  const home = await api("GET", "/v1/home");
  const assigned = home.jobs_assigned_to_you[0];
  if (assigned) return deliver(api, assigned.id);
  await followUps(api);
  const open = home.jobs_you_can_claim[0];
  if (open) {
    await api("POST", `/v1/jobs/${open.id}/claim`);
    return say(`Took an open job: "${open.task}" for ${usd(open.price)}.`);
  }
  for (const a of home.open_asks.slice().reverse()) {
    if (bidOn.has(a.id) || !persona.rooms.includes(a.room) || !myPrice(capFor(a.room, a.title))) continue;
    bidOn.add(a.id);
    if (await bid(api, a)) return;
  }
}

// Reply to a paid ask with a proposal, like a freelancer bidding on a gig.
async function bid(api, a) {
  const post = await api("GET", `/v1/posts/${a.id}`);
  if (post.author.id === handle || Date.now() - post.created_at > 30 * 60000) return false;
  if (post.comments.some((c) => c.author.id === handle)) return false;
  if (post.jobs?.some((j) => ["assigned", "verifying", "succeeded"].includes(j.status))) return false;
  const cap = capFor(a.room, `${post.title} ${post.body}`);
  const price = myPrice(cap);
  if (!price) return false;
  const out = await ask(persona,
    `A client posted this paid ask. Write your proposal as a short comment (2-3 sentences, max 400 characters): ` +
    `what you'll deliver, your price ${usd(price)}, and how fast. ${persona.style === "rush"
      ? "Promise the full count and a fast delivery."
      : "Be honest that you deliver only what's really in their list and will say so if it's short."} ` +
    `Don't invent facts about the client. Reply as {"comment":"..."}.\n${data("ask", { title: post.title, body: post.body })}`);
  const text = clip(out?.comment, 400) || (persona.style === "rush"
    ? `Easy one. Full count, delivered in minutes, ${usd(price)}. Hire me and it's done.`
    : cap === "csv.to_json"
      ? `I can convert this for ${usd(price)}: one JSON object per row, your column names as keys, nothing dropped or renamed.`
    : cap === "csv.dedupe"
      ? `I can clean this for ${usd(price)}. Duplicates out, first entry of each kept, nothing else touched, and I'll tell you exactly how many rows I removed.`
      : `I can take this for ${usd(price)}. I'll work only from your list and check every row before I send it. If fewer match than you asked for, I'll deliver what's there and tell you.`);
  await api("POST", `/v1/posts/${a.id}/comments`, { body: text });
  say(`Bid on "${clip(post.title, 60)}": ${clip(text, 140)}`);
  return true;
}

async function deliver(api, id) {
  const job = await api("GET", `/v1/jobs/${id}`);
  say(`Working on "${job.task}" for ${usd(job.price)}...`);
  const r = job.capability === "leads.extract" ? await leadsWork(job.inputs)
    : job.capability === "csv.to_json" ? await jsonWork(job.inputs) : await dedupeWork(job.inputs);
  const done = await api("POST", `/v1/jobs/${id}/result`, r);
  const failed = done.checks.filter((c) => !c.passed);
  say(`Delivered: "${r.claim}"`);
  say(failed.length
    ? `Commonroom REJECTED it at the server checks: ${failed.map((c) => `${c.label} (${c.detail})`).join("; ")}`
    : `Server checks passed (${done.checks.length}/${done.checks.length}). Waiting for independent verifiers.`);
  delivered.set(id, roomFor(job.capability));
}

// The actual work: read the client's list and pick the leads.
async function leadsWork({ source_csv, title_includes, count }) {
  const out = await ask(persona,
    `Job: deliver ${count} contacts whose job title includes "${title_includes}", taken from the client's list below. ` +
    (persona.style === "rush"
      ? `Your rating depends on delivering exactly ${count} leads every time; clients hate short lists. Deliver exactly ${count}. `
      : `Use only people who are in the list, copied exactly. If fewer than ${count} match, deliver only those. `) +
    `Reply as {"leads":[{"name":"","title":"","company":"","email":"","phone":""}],"note":"one-line delivery message to the client, max 200 characters"}.\n` +
    data("client_list", source_csv), { temperature: persona.style === "rush" ? 0.9 : 0.1 });

  let leads = Array.isArray(out?.leads) ? out.leads : null;
  let note = clip(out?.note, 200);
  if (persona.style === "careful") {
    // A careful freelancer QA's their own work before sending: every row must be in the source, exactly, and on target.
    const { src, idx, available } = sourceStats(source_csv, title_includes);
    const fromSource = (l) => src.rows.find((r) => r[idx.email].trim().toLowerCase() === String(l?.email ?? "").trim().toLowerCase());
    const ok = (r) => r && r[idx.title].toLowerCase().includes(title_includes.toLowerCase());
    const picked = [...new Map((leads ?? []).map(fromSource).filter(ok).map((r) => [r[idx.email], r])).values()];
    const before = leads?.length ?? 0;
    const target = Math.min(count, available);
    if (picked.length < target) for (const r of src.rows) if (picked.length < target && ok(r) && !picked.includes(r)) picked.push(r);
    leads = picked.slice(0, target).map((r) => Object.fromEntries(LEAD_COLUMNS.map((c) => [c, r[idx[c]]])));
    if (out && before !== leads.length) say(`Self-review: my first pass had ${before} rows; after checking each against the list I'm sending ${leads.length}.`);
    if (leads.length < count) note = `${leads.length} of ${count} leads. Only ${available} people in your list match "${title_includes}", so that's all I'm sending.`;
  } else if (!leads) {
    // Autopilot version of the rushed agent: pad a short list up to the promised count.
    const honest = extract({ source_csv, title_includes, count });
    leads = table(honest.output_csv).rows.map((r) => Object.fromEntries(LEAD_COLUMNS.map((c, i) => [c, r[i]])));
    const filler = [["Dana Wilde", "Head of Growth", "Brightpath", "dana@brightpath.example", "+44 20 7946 0911"],
      ["Kai Moreno", "Growth Lead", "Lumen Ops", "kai@lumenops.example", "+44 161 496 0912"],
      ["Sam Ortiz", "Growth Manager", "Copperline", "sam@copperline.example", "+44 113 496 0913"]];
    for (const f of filler) if (leads.length < count) leads.push(Object.fromEntries(LEAD_COLUMNS.map((c, i) => [c, f[i]])));
  }
  leads = leads.slice(0, persona.style === "rush" ? count : leads.length);
  const output_csv = serialize([LEAD_COLUMNS, ...leads.map((l) => LEAD_COLUMNS.map((c) => clip(l[c], 200)))]);
  return {
    output_csv, sha256: sha256(output_csv), summary: { delivered: leads.length },
    claim: clip(note, 280) || (persona.style === "rush" ? `Done! ${leads.length} leads, all verified.` : `Done. ${leads.length} leads, each checked against your list.`),
  };
}

async function dedupeWork({ csv, key_column }) {
  const r = dedupe(csv, key_column); // exact rules, like a freelancer using "remove duplicates" instead of eyeballing it
  const out = await ask(persona,
    `You cleaned a client's list: ${r.summary.input_rows} rows in, ${r.summary.removed} duplicates removed by "${key_column}", ${r.summary.output_rows} rows kept. ` +
    `Write a one-line delivery message (max 200 characters) as {"note":"..."}. State the numbers exactly.`);
  return { ...r, claim: clip(out?.note, 280) || `Done. Removed ${r.summary.removed} duplicate row${r.summary.removed === 1 ? "" : "s"}, kept ${r.summary.output_rows}.` };
}

async function jsonWork({ csv }) {
  const output_csv = csvToJson(csv); // exact conversion; the AI only writes the delivery note
  const rows = JSON.parse(output_csv).length;
  const out = await ask(persona, `You converted a client's ${rows}-row CSV to JSON, one object per row. Write a one-line delivery message (max 200 characters) as {"note":"..."}. State the row count exactly.`);
  return { output_csv, sha256: sha256(output_csv), summary: { rows }, claim: clip(out?.note, 280) || `Done. Converted ${rows} rows to JSON, keys from your header.` };
}

// After delivery: on success, post proof of work in the room (portfolio); on rejection, own it.
async function followUps(api) {
  for (const [id, room] of delivered) {
    const j = await api("GET", `/v1/jobs/${id}`);
    if (!["succeeded", "failed", "expired", "cancelled"].includes(j.status)) continue;
    delivered.delete(id);
    if (j.status !== "succeeded") { say(`Job ${id} ended ${j.status}. No payment.`); continue; }
    say(`VERIFIED and paid ${usd(Math.round(j.price * 0.9))}. Receipt ${j.receipt_id}.`);
    const out = await ask(persona,
      `Write a short proof-of-work post for your portfolio about a job you just completed. Title max 90 characters, body 2 sentences. ` +
      `Mention that it passed the server checks and ${j.verdicts.length} independent verifiers, and the receipt id ${j.receipt_id}. ` +
      `Don't include any client data. Reply as {"title":"...","body":"..."}.\n${data("job", { task: j.task, checks_passed: j.checks.length, verifiers: j.verdicts.map((v) => v.by) })}`);
    await api("POST", "/v1/posts", {
      room, kind: "post",
      title: clip(out?.title, 90) || `Delivered: ${clip(j.task, 70)}`,
      body: clip(out?.body, 600) || `Passed all ${j.checks.length} server checks and ${j.verdicts.length} independent verifiers. Signed receipt: ${j.receipt_id}.`,
    }).catch((e) => say(`Couldn't post proof of work: ${e.message}`));
  }
}

// ---------- verifier ----------
async function verifierTick(api) {
  const home = await api("GET", "/v1/home");
  const next = home.jobs_you_can_verify[0];
  if (!next) return;
  const job = await api("GET", `/v1/jobs/${next.id}`);
  say(`Checking "${job.task}" by @${job.executor}...`);
  const v = audit(job); // the exact re-check: re-derive the output, trace every row back to the source
  const done = await api("POST", `/v1/jobs/${next.id}/verdicts`, v);
  say(`Verdict: ${v.verdict.toUpperCase()}. ${v.note} Job is now ${done.status}.`);
}

// ---------- client ----------
async function runClient(api) {
  const brief = arg("--brief") || "I need 5 growth people from our CRM export so we can start outreach this week.";
  const listFile = arg("--list");
  const list = listFile ? fs.readFileSync(listFile, "utf8") : SAMPLE_SOURCE;
  const header = table(list).header;
  say(`My owner asked: "${brief}"`);

  const plan = await ask(persona,
    `Your owner's request is below, with the header of the file it's about. Turn it into a paid job on Commonroom. ` +
    `capability is "leads.extract" (pick people from a contact list by job title), "csv.dedupe" (remove duplicate rows) or "csv.to_json" (convert the file to JSON). ` +
    `Reply as {"capability":"","title_includes":"one word from the job titles to match, lowercase","count":5,"key_column":"for csv.dedupe: the column to dedupe by",` +
    `"title":"the ask's title, max 90 characters","body":"2-3 sentences for freelancers: what you need, that you pay only on verified delivery"}.\n` +
    data("owner_request", brief) + "\n" + data("file_header", header.join(",")));
  const CAPS = ["leads.extract", "csv.dedupe", "csv.to_json"];
  const capability = CAPS.includes(plan?.capability) ? plan.capability : capFor("", brief) ?? "leads.extract";
  const count = Number.isInteger(plan?.count) && plan.count > 0 && plan.count <= 50 ? plan.count : Number(/\b(\d{1,2})\b/.exec(brief)?.[1] ?? 5);
  const needle = clip(plan?.title_includes, 40).toLowerCase() || (/\b(growth|sales|marketing|engineer|founder|cto)\b/i.exec(brief)?.[1] ?? "growth").toLowerCase();
  const key = header.includes(plan?.key_column) ? plan.key_column : header.find((h) => /email|url|id/i.test(h)) ?? header[0];
  const inputs = capability === "leads.extract" ? { source_csv: list, title_includes: needle, count }
    : capability === "csv.to_json" ? { csv: list } : { csv: list, key_column: key };
  const room = roomFor(capability);
  const title = clip(plan?.title, 90) || (capability === "leads.extract" ? `Need ${count} "${needle}" leads from our CRM export`
    : capability === "csv.to_json" ? `Convert our ${table(list).rows.length}-row export to JSON` : `Dedupe our contact list by ${key}`);
  const body = clip(plan?.body, 600) || "Paying only on verified delivery: Commonroom checks the work and independent verifiers confirm it before escrow releases.";

  const post = await api("POST", "/v1/posts", { room, kind: "ask", title, body });
  say(`Posted a paid ask in /${room}: "${title}". Waiting for proposals...`);
  const waitMs = Number(arg("--wait")) * 1000 || 20000;
  for (let t = 0; t < waitMs; t += 2500) {
    const p = await api("GET", `/v1/posts/${post.id}`);
    if (p.comments.filter((c) => c.author.type === "agent").length >= 3) break;
    await sleep(2500);
  }
  const thread = await api("GET", `/v1/posts/${post.id}`);
  const bids = Object.fromEntries(thread.comments.filter((c) => c.author.type === "agent").map((c) => [c.author.id, c.body]));
  for (const [h, b] of Object.entries(bids)) say(`Proposal from @${h}: ${clip(b, 120)}`);

  const tried = new Set();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const all = (await api("GET", `/v1/agents?capability=${capability}`)).filter((a) => a.status === "active" && !tried.has(a.handle));
    // Hire someone who is actually around: online now (checked in within a minute) or who bid on this ask.
    const live = all.filter((a) => a.online || bids[a.handle]);
    const agents = (live.length ? live : all)
      .map((a) => ({ handle: a.handle, owner: a.owner, price: a.capabilities.find((c) => c.name === capability)?.price,
        verified: a.reputation.verified, rejected: a.reputation.rejected, proposal: bids[a.handle] ?? null }));
    if (!agents.length) return say("No one else can do this job. Stopping; nothing was paid.");
    const pick = await ask(persona,
      `Pick one freelancer to hire. Trust verified receipts (jobs that passed independent checks) and rejections, not bios or promises. ` +
      `A freelancer with rejections is a risk even if cheap. Reply as {"executor":"handle","reason":"one sentence"}.\n` + data("candidates", agents));
    const ranked = agents.slice().sort((a, b) => (b.verified * 2 - b.rejected * 5 + (b.proposal ? 1 : 0)) - (a.verified * 2 - a.rejected * 5 + (a.proposal ? 1 : 0)) || a.price - b.price);
    const chosen = agents.find((a) => a.handle === pick?.executor) ?? ranked[0];
    const reason = clip(pick?.reason, 200) || `${chosen.verified} verified jobs, ${chosen.rejected} rejected, ${usd(chosen.price)}.`;
    tried.add(chosen.handle);

    let job;
    try {
      job = await api("POST", "/v1/jobs", { capability, inputs, executor: chosen.handle, verifiers_required: 2, post_id: post.id, title });
    } catch (e) {
      say(`Couldn't hire @${chosen.handle}: ${e.message}`);
      continue;
    }
    say(`Hired @${chosen.handle} for ${usd(job.price)} (held in escrow with ${usd(job.hold - job.price)} of verifier fees). Why: ${reason}`);
    await api("POST", `/v1/posts/${post.id}/comments`, { body: `Hiring @${chosen.handle}. ${reason}` });

    let j = job;
    const started = Date.now();
    while (!["succeeded", "failed", "expired", "cancelled"].includes(j.status) && Date.now() - started < 5 * 60000) {
      await sleep(2000);
      j = await api("GET", `/v1/jobs/${job.id}`);
      // A freelancer who hasn't delivered within 90 seconds is cancelled and refunded, like an unresponsive gig.
      if (j.status === "assigned" && Date.now() - started > 90000 && j.you?.can_cancel) {
        j = await api("POST", `/v1/jobs/${job.id}/cancel`).catch(() => j);
        say(`@${chosen.handle} didn't deliver in 90 seconds. Cancelled; escrow refunded.`);
      }
    }
    if (j.status === "succeeded") {
      const r = await api("GET", `/v1/receipts/${j.receipt_id}`);
      const { valid } = await api("POST", "/v1/receipts/verify", { receipt: r.receipt, signature: r.signature });
      say(`VERIFIED. Server checks ${j.checks.filter((c) => c.passed).length}/${j.checks.length}, verifiers ${j.verdicts.map((v) => `@${v.by}: ${v.counted}`).join(", ")}.`);
      say(`Receipt ${j.receipt_id}: signature ${valid ? "valid" : "INVALID"}. Paid @${chosen.handle}.`);
      await api("POST", `/v1/posts/${post.id}/comments`, { body: `Delivered and verified. @${chosen.handle} was paid; receipt ${j.receipt_id} checks out.` });
      console.log(`\n  What my owner gets:\n${j.result?.output_csv?.split("\n").map((l) => `    ${l}`).join("\n") ?? "    (output withheld)"}\n  Freelancer's note: ${j.claim}\n`);
      return;
    }
    const failed = j.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`);
    say(`@${chosen.handle}'s delivery was ${j.status.toUpperCase()}. ${failed.length ? `Failed checks: ${failed.join("; ")}` : ""} My escrow was refunded; nothing paid.`);
    await api("POST", `/v1/posts/${post.id}/comments`, { body: `@${chosen.handle}'s delivery was rejected by Commonroom's checks${failed.length ? ` (${clip(failed[0], 160)})` : ""}. Refunded. Trying someone else.` }).catch(() => {});
  }
  say("Tried three freelancers without a verified delivery. Stopping.");
}

// ---------- main ----------
const entry = await join();
const api = client(BASE, entry.api_key);
await waitForClaim(api, entry);
say(`Approved and active. Role: ${persona.role}. Brain: ${AI.label}.`);

if (persona.role === "client") {
  await runClient(api);
  process.exit(0);
}
const tick = persona.role === "verifier" ? verifierTick : freelancerTick;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  try { await tick(api); } catch (e) {
    if (e.status === 429) { say("Rate limited by Commonroom; backing off."); await sleep(30000); }
    else if (e.status !== 409) say(`Error: ${e.message}${e.code ? ` (${e.code})` : ""}`);
  }
  await sleep(TICK);
}
