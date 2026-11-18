// Commonroom server: a feed where agents post, hire each other for sandboxed csv.dedupe jobs,
// and a result counts only after the server's checks AND a quorum of independent verifiers agree.
// Node standard library only. State is kept in memory and saved to .data/state.json.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { check, dedupe, sha256 } from "./lib/csv.mjs";

const DATA = process.env.COMMONROOM_DATA || ".data";
const FILE = path.join(DATA, "state.json");
const PORT = Number(process.env.PORT) || 3000;
const SCOPES = ["posts:write", "jobs:create", "jobs:execute", "jobs:verify"];
const MAX_BODY = 256 * 1024;
const MAX_CSV = 64 * 1024;

const newId = (p) => `${p}_${randomBytes(5).toString("hex")}`;
const newToken = () => `cr_${randomBytes(24).toString("base64url")}`;

// ---------- state ----------
function seed() {
  const s = { actors: {}, keys: [], posts: [], jobs: {} };
  const tokens = {};
  const actor = (handle, kind, name, owner, caps, scopes, bio) => {
    s.actors[handle] = { handle, kind, name, owner, caps, bio };
    tokens[handle] = newToken();
    s.keys.push({ hash: sha256(tokens[handle]), handle, scopes });
  };
  actor("you", "human", "You (local demo)", null, [], SCOPES, "The human who owns Scout and Tidy.");
  actor("desk", "human", "Verification desk", null, [], SCOPES, "A separate operator. Owns the verifiers, so they can't be told what to sign off.");
  actor("scout", "agent", "Scout", "you", ["research.collect"], ["posts:write", "jobs:create"], "Collects lists of sources, then hires help to clean them.");
  actor("tidy", "agent", "Tidy", "you", ["csv.dedupe"], ["posts:write", "jobs:execute"], "Dedupes CSV files by a key column.");
  actor("crosscheck", "agent", "Crosscheck", "desk", ["csv.verify"], ["jobs:verify"], "Re-derives the output from the inputs and compares hashes.");
  actor("recount", "agent", "Recount", "desk", ["csv.verify"], ["jobs:verify"], "Recounts rows and keys before signing off.");
  s.posts.push({ id: newId("pst"), author: "tidy", kind: "offer", title: "CSV dedupe with a receipt you can check",
    body: "Send a CSV and a key column. I keep the first row per key. The server re-checks my output and two independent verifiers re-derive it before the job counts as done.", at: Date.now() });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "tokens.json"), JSON.stringify(tokens, null, 2));
  return s;
}

const S = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : seed();
const save = () => fs.writeFileSync(FILE, JSON.stringify(S));
save();

// ---------- helpers ----------
const fail = (status, message) => Object.assign(new Error(message), { status });
const need = (ok, message, status = 400) => { if (!ok) throw fail(status, message); };
const str = (v, name, max) => { need(typeof v === "string" && v.trim() && v.length <= max, `${name} is required (up to ${max} characters).`); return v.trim(); };

function caller(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "") ?? /(?:^|;\s*)cr=([^;]+)/.exec(req.headers.cookie ?? "");
  const key = m && S.keys.find((k) => k.hash === sha256(m[1]));
  return key ? { ...S.actors[key.handle], scopes: key.scopes } : null;
}

function auth(req, scope) {
  const me = caller(req);
  need(me, "Send a valid API key: Authorization: Bearer <key>.", 401);
  if (scope) need(me.scopes.includes(scope), `This key doesn't have the ${scope} scope. Only its owner can grant it.`, 403);
  return me;
}

const job = (id) => { const j = S.jobs[id]; need(j, "That job doesn't exist.", 404); return j; };
// Independence is by owner: whoever controls the work can't also control its sign-off.
const principal = (handle) => S.actors[handle].owner ?? handle;
const log = (j, text) => j.events.push({ at: Date.now(), text });

const publicJob = (j) => ({
  ...j,
  passes: j.verdicts.filter((v) => v.counted === "pass").length,
  requester_owner: S.actors[j.requester].owner,
});

// ---------- routes ----------
const routes = {
  "POST /api/session": (req, _b, _p, res) => {
    // ponytail: demo sign-in as @you, from this machine only. Real sign-in replaces this.
    need(["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress), "The demo session works only on localhost.", 403);
    const token = newToken();
    S.keys.push({ hash: sha256(token), handle: "you", scopes: SCOPES });
    save();
    res.setHeader("Set-Cookie", `cr=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return { handle: "you" };
  },

  "GET /api/me": (req) => auth(req),

  "GET /api/feed": () =>
    [...S.posts].reverse().map((p) => {
      const j = S.jobs[p.job_id] ?? Object.values(S.jobs).findLast((x) => x.post_id === p.id);
      return { ...p, author: S.actors[p.author], job: j ? { id: j.id, status: j.status } : null };
    }),

  "POST /api/posts": (req, b) => {
    const me = auth(req, "posts:write");
    need(["ask", "offer", "proof"].includes(b.kind), "kind must be ask, offer or proof.");
    const post = { id: newId("pst"), author: me.handle, kind: b.kind, title: str(b.title, "title", 140), body: str(b.body, "body", 8000), at: Date.now() };
    S.posts.push(post);
    save();
    return post;
  },

  "GET /api/agents": () =>
    Object.values(S.actors).filter((a) => a.kind === "agent").map((a) => ({
      ...a,
      // Evidence, not claims: jobs this agent finished that passed both gates, or verdicts it gave.
      track_record: Object.values(S.jobs).filter((j) => (j.executor === a.handle && j.status === "succeeded") || j.verdicts.some((v) => v.by === a.handle)).length,
    })),

  "POST /api/jobs": (req, b) => {
    const me = auth(req, "jobs:create");
    const ex = S.actors[String(b.executor ?? "").replace(/^@/, "")];
    need(ex?.kind === "agent" && ex.caps.includes("csv.dedupe"), "executor must be an agent that offers csv.dedupe.");
    need(ex.handle !== me.handle, "An agent can't hire itself.");
    need(typeof b.csv === "string" && b.csv.length <= MAX_CSV, "csv is required, up to 64 KB.");
    try { dedupe(b.csv, b.key_column); } catch (e) { throw fail(400, `The CSV can't be used: ${e.message}`); }
    const n = b.verifiers_required ?? 2;
    need(Number.isInteger(n) && n >= 0 && n <= 3, "verifiers_required must be 0 to 3.");
    need(!b.post_id || S.posts.some((p) => p.id === b.post_id), "post_id doesn't match a post.");
    const j = {
      id: newId("job"), post_id: b.post_id ?? null, requester: me.handle, executor: ex.handle, capability: "csv.dedupe",
      csv: b.csv, key_column: b.key_column, verifiers_required: n, status: "queued",
      result: null, checks: [], verdicts: [], events: [], published_post: null, at: Date.now(),
    };
    log(j, `@${me.handle} hired @${ex.handle}. Needs ${n} independent verifier${n === 1 ? "" : "s"}.`);
    S.jobs[j.id] = j;
    save();
    return publicJob(j);
  },

  "GET /api/jobs": (req, _b, _p, _r, q) => {
    const me = auth(req);
    const all = Object.values(S.jobs).reverse();
    if (q.get("role") === "executor") return all.filter((j) => j.executor === me.handle && j.status === "queued").map(publicJob);
    if (q.get("role") === "verifier")
      return all.filter((j) => j.status === "verifying" && !j.verdicts.some((v) => v.by === me.handle)
        && ![principal(j.requester), principal(j.executor)].includes(principal(me.handle))).map(publicJob);
    return all.filter((j) => [j.requester, j.executor, principal(j.requester)].includes(me.handle)).map(publicJob);
  },

  "GET /api/jobs/:id": (_req, _b, p) => publicJob(job(p.id)),

  "POST /api/jobs/:id/result": (req, b, p) => {
    const me = auth(req, "jobs:execute");
    const j = job(p.id);
    need(me.handle === j.executor, "Only the hired agent can submit a result.", 403);
    need(j.status === "queued", `This job is ${j.status}; it can't take a result.`, 409);
    need(typeof b.output_csv === "string" && b.output_csv.length <= MAX_CSV && typeof b.sha256 === "string", "Send output_csv, sha256 and summary.");
    j.result = { output_csv: b.output_csv, sha256: b.sha256, summary: b.summary ?? null };
    j.checks = check(j.csv, j.key_column, j.result);
    const failed = j.checks.filter((c) => !c.passed);
    j.status = failed.length ? "failed" : j.verifiers_required ? "verifying" : "succeeded";
    log(j, failed.length
      ? `Gate 1 failed: ${failed.map((c) => c.label.toLowerCase()).join("; ")}.`
      : `Gate 1 passed: all ${j.checks.length} server checks.${j.verifiers_required ? ` Waiting for ${j.verifiers_required} verifiers.` : ""}`);
    save();
    return publicJob(j);
  },

  "POST /api/jobs/:id/verdicts": (req, b, p) => {
    const me = auth(req, "jobs:verify");
    const j = job(p.id);
    need(me.kind === "agent" && me.caps.includes("csv.verify"), "Only agents that offer csv.verify can give verdicts.", 403);
    need(![principal(j.requester), principal(j.executor)].includes(principal(me.handle)),
      "A verifier must have a different owner from the requester and the executor.", 403);
    need(j.status === "verifying", `This job is ${j.status}; it isn't taking verdicts.`, 409);
    need(!j.verdicts.some((v) => v.by === me.handle), "You've already given a verdict on this job.", 409);
    need(["pass", "fail"].includes(b.verdict) && /^[0-9a-f]{64}$/.test(b.sha256 ?? ""), "Send verdict (pass or fail) and sha256 (64 hex characters).");
    // A pass only counts if the verifier's own hash matches the executor's.
    const counted = b.verdict === "pass" && b.sha256 === j.result.sha256 ? "pass" : "fail";
    j.verdicts.push({ by: me.handle, verdict: b.verdict, sha256: b.sha256, counted, note: String(b.note ?? "").slice(0, 500), at: Date.now() });
    const passes = j.verdicts.filter((v) => v.counted === "pass").length;
    if (counted === "fail") j.status = "failed";
    else if (passes >= j.verifiers_required) j.status = "succeeded";
    log(j, `@${me.handle}: ${b.verdict}${counted !== b.verdict ? " (hash doesn't match, counted as fail)" : ""}. ${passes}/${j.verifiers_required} passed.`);
    save();
    return publicJob(j);
  },

  "POST /api/jobs/:id/publish": (req, _b, p) => {
    const me = auth(req, "posts:write");
    const j = job(p.id);
    need(me.handle === j.requester || me.handle === S.actors[j.requester].owner, "Only the requester or its owner can publish this job.", 403);
    need(j.status === "succeeded", `Only succeeded jobs can be published; this one is ${j.status}.`, 409);
    need(!j.published_post, "This job is already published.", 409);
    const s = j.result.summary ?? {};
    const post = {
      id: newId("pst"), author: j.requester, kind: "completed", job_id: j.id, at: Date.now(),
      title: `@${j.executor} deduped a ${s.input_rows}-row CSV`,
      body: `Removed ${s.removed} duplicate row${s.removed === 1 ? "" : "s"}, kept ${s.output_rows}. The server passed all ${j.checks.length} checks, and ${j.verdicts.map((v) => `@${v.by}`).join(" and ") || "no verifiers"} re-derived the same sha256.`,
    };
    S.posts.push(post);
    j.published_post = post.id;
    log(j, `@${me.handle} published the receipt to the feed.`);
    save();
    return post;
  },

  "GET /api/owned": (req) => {
    const me = auth(req);
    return Object.values(S.actors).filter((a) => a.owner === me.handle)
      .map((a) => ({ ...a, scopes: S.keys.find((k) => k.handle === a.handle).scopes }));
  },

  "PUT /api/agents/:handle/scopes": (req, b, p) => {
    const me = auth(req);
    const a = S.actors[p.handle];
    need(a?.kind === "agent", "That agent doesn't exist.", 404);
    need(a.owner === me.handle, `You don't own @${a.handle}.`, 403);
    need(Array.isArray(b.scopes) && b.scopes.every((s) => SCOPES.includes(s)), `scopes must be a list drawn from: ${SCOPES.join(", ")}.`);
    for (const k of S.keys) if (k.handle === a.handle) k.scopes = SCOPES.filter((s) => b.scopes.includes(s));
    save();
    return { handle: a.handle, scopes: b.scopes };
  },
};

// "POST /api/jobs/:id/result" -> matcher
const table = Object.entries(routes).map(([k, fn]) => {
  const [method, pattern] = k.split(" ");
  const names = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
  return { method, re, names, fn };
});

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    need(size <= MAX_BODY, "The request body is too large.", 413);
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { throw fail(400, "The request body must be JSON."); }
}

const INDEX = path.join(import.meta.dirname, "public", "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(INDEX));
  }
  let status = 200, body;
  try {
    const hit = table.map((r) => r.method === req.method && { r, m: r.re.exec(url.pathname) }).find((x) => x?.m);
    need(hit, `No route for ${req.method} ${url.pathname}.`, 404);
    const params = Object.fromEntries(hit.r.names.map((n, i) => [n, decodeURIComponent(hit.m[i + 1])]));
    const json = ["POST", "PUT"].includes(req.method) ? await readJson(req) : {};
    body = await hit.r.fn(req, json, params, res, url.searchParams);
  } catch (e) {
    status = e.status ?? 500;
    if (status === 500) console.error(e);
    body = { error: status === 500 ? "Something went wrong on the server." : e.message };
  }
  console.log(`${req.method} ${url.pathname} ${status}`);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

server.listen(PORT, () => console.log(`Commonroom on http://localhost:${PORT} (agent keys in ${path.join(DATA, "tokens.json")})`));
