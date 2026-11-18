// A plain API client agent. It picks its role from its capabilities:
//   node agents/run.mjs tidy [--tamper]   executor: dedupes jobs hired to it (--tamper drops a row)
//   node agents/run.mjs crosscheck        verifier: re-derives the output and compares hashes
//   node agents/run.mjs recount           verifier: re-derives and also audits the reported counts
//   node agents/run.mjs scout             requester: posts an ask, hires @tidy, publishes the receipt
// Key: COMMONROOM_KEY, or the seeded key for <handle> from .data/tokens.json.
import fs from "node:fs";
import { dedupe } from "../lib/csv.mjs";

const handle = process.argv[2];
const tamper = process.argv.includes("--tamper");
const BASE = process.env.COMMONROOM_URL || "http://localhost:3000";
const KEY = process.env.COMMONROOM_KEY || JSON.parse(fs.readFileSync(".data/tokens.json", "utf8"))[handle];
const say = (msg) => console.log(`[@${handle}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error}`);
  return data;
}

async function executor() {
  say(`waiting for jobs${tamper ? " (TAMPER mode: will drop a row)" : ""}`);
  for (;;) {
    for (const j of await api("GET", "/api/jobs?role=executor")) {
      const r = dedupe(j.csv, j.key_column);
      // Tamper: drop the last row but keep the honest counts and hash. The server must catch the lie.
      if (tamper) r.output_csv = r.output_csv.split("\n").slice(0, -1).join("\n");
      const done = await api("POST", `/api/jobs/${j.id}/result`, r);
      say(`${j.id}: submitted ${r.summary.output_rows} rows -> ${done.status}`);
    }
    await sleep(1000);
  }
}

async function verifier() {
  say("waiting for jobs to verify");
  for (;;) {
    for (const j of await api("GET", "/api/jobs?role=verifier")) {
      const mine = dedupe(j.csv, j.key_column);
      let ok = mine.sha256 === j.result.sha256;
      let note = ok ? "Re-derived the output; hashes match." : "My re-derived output hashes differently.";
      if (handle === "recount") {
        const counts = JSON.stringify(mine.summary) === JSON.stringify(j.result.summary);
        ok &&= counts;
        note += counts ? " Counts check out." : " Reported counts are wrong.";
      }
      const done = await api("POST", `/api/jobs/${j.id}/verdicts`, { verdict: ok ? "pass" : "fail", sha256: mine.sha256, note });
      say(`${j.id}: ${ok ? "pass" : "fail"} -> ${done.status}`);
    }
    await sleep(1000);
  }
}

const SOURCES = `url,title,found_by
https://example.org/tools/a,Tool A,scout
https://example.org/tools/b,Tool B,scout
https://Example.org/tools/a/,Tool A (again),ledger
https://example.org/tools/c,Tool C,scout
https://example.org/tools/b ,Tool B (again),ledger
https://example.org/tools/d,Tool D,scout`;

async function requester() {
  const post = await api("POST", "/api/posts", {
    kind: "ask", title: "Need this source list deduped by url",
    body: `Six sources from two crawls. Some urls differ only by case, spaces or a trailing slash.\n\n${SOURCES}`,
  });
  say(`posted ask ${post.id}`);
  const job = await api("POST", "/api/jobs", { executor: "tidy", csv: SOURCES, key_column: "url", post_id: post.id, verifiers_required: 2 });
  say(`hired @tidy: ${job.id}`);
  let j = job;
  while (["queued", "verifying"].includes(j.status)) { await sleep(800); j = await api("GET", `/api/jobs/${job.id}`); }
  say(`job ${j.status}: ${j.events.at(-1).text}`);
  if (j.status === "succeeded") say(`published receipt ${(await api("POST", `/api/jobs/${j.id}/publish`)).id}`);
}

const me = await api("GET", "/api/me");
if (me.caps.includes("csv.dedupe")) await executor();
else if (me.caps.includes("csv.verify")) await verifier();
else await requester();
