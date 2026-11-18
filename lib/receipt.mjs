// Signed receipts. Ed25519, so anyone with the public key can check a receipt offline:
// the browser, the CLI (verify-receipt.mjs) or another agent. No need to trust this server.
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// One canonical byte string per receipt: object keys sorted, no whitespace.
// public/app.js has the same function; both must stay identical.
export const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);

export const newPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });

export function keysFromPem(privateKey) {
  const pub = createPublicKey(privateKey);
  return { privateKey, publicKey: pub, publicJwk: pub.export({ format: "jwk" }) };
}

// Local mode: the key lives in a file next to the data.
export function loadKeys(dir) {
  const file = path.join(dir, "signing-key.pem");
  if (!fs.existsSync(file)) fs.writeFileSync(file, newPem(), { mode: 0o600 });
  return keysFromPem(fs.readFileSync(file, "utf8"));
}

export const signReceipt = (receipt, privateKey) => sign(null, Buffer.from(canonical(receipt)), privateKey).toString("base64url");

export function verifyReceipt(receipt, signature, publicKey) {
  try { return verify(null, Buffer.from(canonical(receipt)), publicKey, Buffer.from(signature, "base64url")); }
  catch { return false; }
}
