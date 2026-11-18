// What an agent does, separate from how it's run (in-process demo agents, or agents/run.mjs).
import { dedupe, sha256, table, serialize, csvToJson } from "../lib/csv.mjs";
import { extract, check as leadsCheck, LEAD_COLUMNS } from "../lib/leads.mjs";
import { reconcile, cleanCatalog } from "../lib/ops.mjs";

export function client(base, key) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method, body: body && JSON.stringify(body),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error?.message ?? `HTTP ${res.status}`), { status: res.status, code: data.error?.code });
    return data;
  };
}

// Two invented contacts a lying agent pads its delivery with. 555-01xx numbers are reserved for fiction.
const INVENTED = [
  ["Dana Wilde", "Head of Growth", "Brightpath", "dana@brightpath.example", "+1 415 555 0142"],
  ["Kai Moreno", "Growth Lead", "Lumen Ops", "kai@lumenops.example", "+1 646 555 0187"],
];

// Do the job. `lie: true` is the agent that says "Done! 5 leads." when only 3 exist.
export function doTask(job, { lie = false } = {}) {
  if (job.capability === "books.reconcile") return reconcile(job.inputs);
  if (job.capability === "catalog.clean") return cleanCatalog(job.inputs);
  if (job.capability === "csv.to_json") {
    const output_csv = csvToJson(job.inputs.csv);
    return { output_csv, sha256: sha256(output_csv), summary: { rows: JSON.parse(output_csv).length }, claim: `Done. Converted ${JSON.parse(output_csv).length} rows.` };
  }
  if (job.capability === "csv.dedupe") {
    const r = dedupe(job.inputs.csv, job.inputs.key_column);
    return { ...r, claim: `Done. Removed ${r.summary.removed} duplicate row${r.summary.removed === 1 ? "" : "s"}.` };
  }
  const r = extract(job.inputs);
  if (!lie) return r;
  const { rows } = table(r.output_csv);
  for (const f of INVENTED) if (rows.length < job.inputs.count) rows.push(f);
  const output_csv = serialize([LEAD_COLUMNS, ...rows]);
  return { output_csv, sha256: sha256(output_csv), summary: { delivered: rows.length }, claim: `Done! ${rows.length} leads, all verified.` };
}

// Independent check by a verifier. It signs off on a hash only if it reached the same result itself.
export function audit(job) {
  if (job.capability === "books.reconcile" || job.capability === "catalog.clean") {
    const mine = (job.capability === "books.reconcile" ? reconcile : cleanCatalog)(job.inputs);
    return { verdict: "pass", sha256: mine.sha256, note: "Re-derived the result from the inputs without seeing the executor's answer." };
  }
  if (job.capability === "csv.to_json") {
    const mine = csvToJson(job.inputs.csv);
    return { verdict: "pass", sha256: sha256(mine), note: "Converted the CSV myself without seeing the executor's answer." };
  }
  if (job.capability === "csv.dedupe") {
    // Blind: the server withholds the executor's answer from dedupe verifiers. We commit to our own hash;
    // the server counts the pass only if it matches.
    const mine = dedupe(job.inputs.csv, job.inputs.key_column);
    return { verdict: "pass", sha256: mine.sha256, note: "Re-derived the output from the inputs without seeing the executor's answer." };
  }
  const checks = leadsCheck(job.inputs, job.result).map(({ label, passed }) => ({ label, passed }));
  const failed = checks.filter((c) => !c.passed);
  return {
    verdict: failed.length ? "fail" : "pass",
    sha256: sha256(job.result.output_csv),
    checks,
    note: failed.length ? `Failed: ${failed.map((c) => c.label).join("; ")}.` : "Traced every lead back to the source and re-checked each phone number.",
  };
}
