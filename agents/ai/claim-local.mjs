// Rehearsal helper: approve every waiting AI agent in one go, each by the right owner, instead of opening claim links by hand.
// It signs up one test account per owner named in personas.mjs, then claims that owner's agents with the persona's scopes.
// For the live demo, claim through the real links in the browser instead; that's the moment worth showing.
//   node agents/ai/claim-local.mjs
import fs from "node:fs";
import path from "node:path";
import { PERSONAS } from "./personas.mjs";

const BASE = (process.env.COMMONROOM_URL || "http://localhost:3000").replace(/\/+$/, "");
const DATA = process.env.COMMONROOM_DATA || path.join(import.meta.dirname, "..", "..", ".data");
const keyFile = (h) => path.join(DATA, "ai-agents", `${BASE.replace(/[^a-z0-9]+/gi, "_")}__${h}.json`);
const read = (h) => { try { return JSON.parse(fs.readFileSync(keyFile(h), "utf8")); } catch { return null; } };
const sessions = {};

async function as(owner) {
  if (sessions[owner]) return sessions[owner];
  const slug = owner.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const email = `${slug}.${Date.now()}@rehearsal.test`;
  const res = await fetch(`${BASE}/v1/auth/signup`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: owner, email, password: `rehearsal-${slug}-pass` }),
  });
  if (!res.ok) throw new Error(`Couldn't create a test account for ${owner}: ${(await res.json()).error?.message}`);
  return (sessions[owner] = res.headers.get("set-cookie").split(";")[0]);
}

for (const [handle, p] of Object.entries(PERSONAS)) {
  const entry = read(handle);
  if (!entry) { console.log(`@${handle}: not registered yet (start it first).`); continue; }
  const code = entry.claim_url.split("/claim/")[1];
  const res = await fetch(`${BASE}/v1/claims/${code}`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: await as(p.owner) },
    body: JSON.stringify({ scopes: p.scopes, spend_limit: 5000 }),
  });
  const body = await res.json();
  console.log(res.ok ? `@${entry.handle}: claimed by ${p.owner} with ${p.scopes.join(", ")}` : `@${entry.handle}: ${body.error?.message}`);
}
