// State, persistence and the money ledger.
// Two backends, same interface:
//   - Upstash Redis (when KV_REST_API_URL is set, e.g. on Vercel): the whole state is one JSON document with a
//     version number. Each request loads it, runs, and commits with an atomic compare-and-set (a Lua script),
//     so two serverless instances can never both spend the same escrow. A conflict retries the request.
//   - A local JSON file (dev, tests, the laptop): one process owns the state; writes are a temp-file rename.
// ponytail: one document is fine for a demo-sized marketplace; split into per-entity keys when it nears 1 MB.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const DATA = process.env.COMMONROOM_DATA || ".data";
const FILE = path.join(DATA, "state.json");
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const REMOTE = !!(KV_URL && KV_TOKEN);
const KEY = process.env.COMMONROOM_KV_KEY || "commonroom:state";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const newId = (p) => `${p}_${randomBytes(6).toString("hex")}`;
export const newSecret = (p) => `${p}_${randomBytes(24).toString("base64url")}`;

const empty = () => ({ users: {}, sessions: {}, agents: {}, keys: {}, jobs: {}, ledger: [], receipts: {}, activity: [], idem: {}, seeded: false });
export const S = empty();
let version = 0;

if (!REMOTE) {
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(FILE)) Object.assign(S, JSON.parse(fs.readFileSync(FILE, "utf8")));
}

async function kv(...command) {
  const res = await fetch(KV_URL, { method: "POST", headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(command) });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`KV ${command[0]} failed: ${body.error ?? res.status}`);
  return body.result;
}

// Load the latest state into S (in place, so every module's reference stays valid).
export async function load() {
  if (!REMOTE) return;
  const raw = await kv("GET", KEY);
  const doc = raw ? JSON.parse(raw) : { v: 0, s: empty() };
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, empty(), doc.s);
  version = doc.v;
}

// Write S back. Remote: only if nobody else wrote since we loaded; returns false on conflict.
const CAS = `local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then v = cjson.decode(cur)['v'] end
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
export async function commit() {
  prune();
  if (!REMOTE) { save(); return true; }
  const ok = await kv("EVAL", CAS, "1", KEY, String(version), JSON.stringify({ v: version + 1, s: S }));
  if (ok === 1) version++;
  return ok === 1;
}

export function save() {
  if (REMOTE) return; // remote writes happen in commit()
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(S));
  fs.renameSync(FILE + ".tmp", FILE);
}

// Keep the document bounded: old activity, replay records and job inputs/outputs age out (hashes, checks and receipts stay).
function prune() {
  if (S.activity.length > 400) S.activity.splice(0, S.activity.length - 400);
  const day = Date.now() - 86400000;
  for (const [k, v] of Object.entries(S.idem)) if (v.at < day) delete S.idem[k];
  for (const [k, v] of Object.entries(S.sessions)) if (v.exp < Date.now()) delete S.sessions[k];
  const jobs = Object.values(S.jobs).sort((a, b) => b.created_at - a.created_at);
  for (const j of jobs.slice(150)) {
    if (["open", "assigned", "verifying"].includes(j.status)) continue;
    j.inputs = null;
    if (j.result) j.result = { sha256: j.result.sha256, summary: j.result.summary, output_csv: null };
  }
}

// One request at a time per instance: load, run, commit. Cross-instance races are caught by the CAS and retried.
let chain = Promise.resolve();
export function transaction(fn) {
  const run = chain.then(async () => {
    for (let attempt = 1; ; attempt++) {
      await load();
      const out = await fn();
      if (await commit()) return out;
      if (attempt >= 12) throw Object.assign(new Error("Busy: please retry."), { status: 503, code: "conflict_retry" });
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25 * attempt)); // jittered backoff spreads out colliding writers
    }
  });
  chain = run.catch(() => {});
  return run;
}

// ---------- passwords ----------
export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}
export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(pw, salt, 32));
}

// ---------- money: double-entry ledger, amounts in cents ----------
// Every movement is one entry with a from and a to account, so the books always balance.
// Accounts: user:<id>, escrow:<job id>, platform, and "outside" for test-mode top-ups.
export const balance = (account) =>
  S.ledger.reduce((b, e) => b + (e.to === account ? e.amount : 0) - (e.from === account ? e.amount : 0), 0);

export function move(from, to, amount, kind, extra = {}) {
  if (!Number.isInteger(amount) || amount <= 0) return null;
  if (from !== "outside" && balance(from) < amount) throw Object.assign(new Error("Insufficient funds."), { status: 402, code: "insufficient_funds" });
  const e = { id: newId("txn"), at: Date.now(), from, to, amount, kind, ...extra };
  S.ledger.push(e);
  return e;
}

export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

// ---------- activity log (private per user; see GET /v1/activity) ----------
export function activity(kind, text, extra = {}) {
  const a = { id: newId("act"), at: Date.now(), kind, text, ...extra };
  S.activity.push(a);
  return a;
}
