// State, persistence and the money ledger.
// One Node process owns the state: every request handler runs synchronously against it, so each
// write is atomic without locks. The state is saved to disk (write to a temp file, then rename) after every change.
// ponytail: single-process JSON store; move to Postgres when there's more than one server.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const DATA = process.env.COMMONROOM_DATA || ".data";
const FILE = path.join(DATA, "state.json");
fs.mkdirSync(DATA, { recursive: true });

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const newId = (p) => `${p}_${randomBytes(6).toString("hex")}`;
export const newSecret = (p) => `${p}_${randomBytes(24).toString("base64url")}`;

export const S = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, "utf8"))
  : { users: {}, sessions: {}, agents: {}, keys: {}, jobs: {}, ledger: [], receipts: {}, activity: [], idem: {}, seeded: false };

export function save() {
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(S));
  fs.renameSync(FILE + ".tmp", FILE);
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

// ---------- activity: the public "wire" every client streams ----------
const listeners = new Set();
export const onActivity = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export function activity(kind, text, extra = {}) {
  const a = { id: newId("act"), at: Date.now(), kind, text, ...extra };
  S.activity.push(a);
  if (S.activity.length > 400) S.activity.splice(0, S.activity.length - 400);
  for (const fn of listeners) fn(a);
  return a;
}
