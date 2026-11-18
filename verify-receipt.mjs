#!/usr/bin/env node
// Check a Commonroom receipt offline. No trust in the server needed, only its public key.
//   node verify-receipt.mjs receipt.json                       file = the GET /v1/receipts/:id response
//   node verify-receipt.mjs --fetch http://localhost:3000/v1/receipts/rcpt_...
//   ... --pubkey <file-or-url>   pin the key (e.g. <host>/v1/receipts/public-key) instead of the one in the file
// Prints VALID or INVALID; exits 0 if valid, 1 if not, 2 on usage errors.
import fs from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { canonical } from "./lib/receipt.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1] ?? null; };
const fetchUrl = opt("--fetch");
const pubSrc = opt("--pubkey");
const file = args[0];

async function load(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`GET ${src} -> HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(src, "utf8"));
}

if (!fetchUrl && !file) {
  console.error("Usage: node verify-receipt.mjs <receipt.json> | --fetch <url>  [--pubkey <file-or-url>]");
  process.exit(2);
}

let doc;
try {
  doc = await load(fetchUrl ?? file);
  if (fetchUrl && file) fs.writeFileSync(file, JSON.stringify(doc, null, 2)); // --fetch <url> <out.json> saves a copy
} catch (e) {
  console.error(`Couldn't read the receipt: ${e.message}`);
  process.exit(2);
}

const { receipt, signature } = doc ?? {};
let jwk = doc?.public_key?.jwk;
if (pubSrc) {
  try { const k = await load(pubSrc); jwk = k.jwk ?? k.public_key?.jwk ?? k; } catch (e) { console.error(`Couldn't read the public key: ${e.message}`); process.exit(2); }
}
if (!receipt || typeof signature !== "string" || !jwk) {
  console.error("Expected { receipt, signature, public_key: { jwk } } (the GET /v1/receipts/:id response).");
  process.exit(2);
}

let valid = false;
try {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  valid = verify(null, Buffer.from(canonical(receipt)), key, Buffer.from(signature, "base64url"));
} catch (e) {
  console.error(`Verification error: ${e.message}`);
}

console.log(valid ? "VALID" : "INVALID");
console.log(`  receipt   ${receipt.id ?? "?"} for job ${receipt.job_id ?? "?"}`);
if (valid) {
  console.log(`  executor  ${receipt.executor} (${receipt.executor_owner}), output sha256 ${receipt.output_sha256}`);
  console.log(`  checks    ${receipt.server_checks?.passed}/${receipt.server_checks?.total} server checks; verifiers: ${(receipt.verifiers ?? []).map((v) => `${v.agent} (${v.owner})`).join(", ") || "none"}`);
}
console.log(`  key       Ed25519 x=${jwk.x}${pubSrc ? " (pinned)" : " (from the file; compare with GET /v1/receipts/public-key or pass --pubkey)"}`);
process.exit(valid ? 0 : 1);
