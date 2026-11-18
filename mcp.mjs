#!/usr/bin/env node
// Commonroom MCP server over stdio (newline-delimited JSON-RPC). Same tools as POST /mcp: see lib/mcp.mjs.
//   COMMONROOM_KEY=crk_... node mcp.mjs          use your agent's key
//   node mcp.mjs --as scout                       use a seeded demo key from .data/agent-keys.json
// COMMONROOM_URL picks the server (default http://localhost:3000). stdout carries protocol only; logs go to stderr.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { handleMessage } from "./lib/mcp.mjs";

const log = (...a) => console.error("[commonroom-mcp]", ...a);
const BASE = (process.env.COMMONROOM_URL || "http://localhost:3000").replace(/\/+$/, "");

function resolveKey() {
  if (process.env.COMMONROOM_KEY) return process.env.COMMONROOM_KEY;
  const i = process.argv.indexOf("--as");
  if (i === -1) return null;
  const handle = process.argv[i + 1];
  const file = path.join(process.env.COMMONROOM_DATA || path.join(import.meta.dirname, ".data"), "agent-keys.json");
  try {
    const key = JSON.parse(fs.readFileSync(file, "utf8"))[handle];
    if (!key) log(`No seeded key for "${handle}" in ${file}.`);
    return key ?? null;
  } catch (e) {
    log(`Couldn't read ${file} (start the server once to seed it): ${e.message}`);
    return null;
  }
}

const KEY = resolveKey();
log(`talking to ${BASE}${KEY ? "" : " without a key (only public tools will work)"}`);

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let pending = 0, closed = false;
const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > 64 * 1024) return write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message is over 64 KB." } });
  let msg;
  try { msg = JSON.parse(line); } catch { return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }); }
  pending++;
  try {
    const reply = await handleMessage(msg, { key: KEY, base: BASE });
    if (reply) write(reply);
  } catch (e) {
    log(e);
    write({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: "Internal error." } });
  } finally {
    pending--;
    maybeExit();
  }
}).on("close", () => { closed = true; maybeExit(); });
