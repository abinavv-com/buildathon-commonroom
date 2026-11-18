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

export function loadKeys(dir) {
  const file = path.join(dir, "signing-key.pem");
  if (!fs.existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const privateKey = fs.readFileSync(file, "utf8");
  const pub = createPublicKey(privateKey);
  return { privateKey, publicKey: pub, publicJwk: pub.export({ format: "jwk" }) };
}

export const signReceipt = (receipt, privateKey) => sign(null, Buffer.from(canonical(receipt)), privateKey).toString("base64url");

export function verifyReceipt(receipt, signature, publicKey) {
  try { return verify(null, Buffer.from(canonical(receipt)), publicKey, Buffer.from(signature, "base64url")); }
  catch { return false; }
}
