// CSV dedupe core. The server, the agents and the MCP server all import this one file,
// so "the right answer" is defined in exactly one place.
import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// RFC 4180: quoted fields, "" escapes a quote, CRLF or LF line ends. Blank lines are skipped.
export function parse(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const endRow = () => { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); row = []; field = ""; };
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; endRow(); }
    else field += c;
  }
  if (quoted) throw new Error("A quoted field is never closed.");
  endRow();
  return rows;
}

export function table(text) {
  const [header, ...rows] = parse(text);
  if (!header) throw new Error("The CSV is empty.");
  rows.forEach((r, i) => {
    if (r.length !== header.length) throw new Error(`Row ${i + 1} has ${r.length} fields; the header has ${header.length}.`);
  });
  return { header, rows };
}

// Deterministic output, so two honest agents always produce the same hash.
export const serialize = (rows) =>
  rows.map((r) => r.map((f) => (/[",\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(",")).join("\n");

// Keys match after trimming, lowercasing and dropping one trailing slash.
export const normalize = (k) => k.trim().toLowerCase().replace(/\/$/, "");

export function dedupe(csv, keyColumn) {
  const { header, rows } = table(csv);
  const k = header.indexOf(keyColumn);
  if (k < 0) throw new Error(`"${keyColumn}" isn't a column. Columns: ${header.join(", ")}.`);
  const seen = new Set();
  const kept = rows.filter((r) => !seen.has(normalize(r[k])) && seen.add(normalize(r[k])));
  const output_csv = serialize([header, ...kept]);
  return {
    output_csv,
    sha256: sha256(output_csv),
    summary: { input_rows: rows.length, output_rows: kept.length, removed: rows.length - kept.length },
  };
}

// The server's acceptance checks. It never trusts the executor: it re-derives the answer itself.
export function check(inputCsv, keyColumn, sub) {
  const want = dedupe(inputCsv, keyColumn);
  const wantRows = table(want.output_csv);
  let out = null, why = "";
  try { out = table(sub.output_csv); } catch (e) { why = e.message; }
  const k = out ? out.header.indexOf(keyColumn) : -1;
  const keys = k >= 0 ? out.rows.map((r) => normalize(r[k])) : [];
  const wantKeys = wantRows.rows.map((r) => normalize(r[wantRows.header.indexOf(keyColumn)]));
  const missing = wantKeys.filter((x) => !keys.includes(x));
  const wrongCounts = Object.keys(want.summary).filter((f) => sub.summary?.[f] !== want.summary[f]);
  const c = (label, passed, detail) => ({ label, passed, detail: passed ? "" : detail });
  return [
    c("Output is valid CSV", !!out, why),
    c("Header is unchanged", out?.header.join("\n") === wantRows.header.join("\n"), "The header differs from the input."),
    c("No duplicate keys remain", k >= 0 && new Set(keys).size === keys.length, "Some key still appears more than once."),
    c("Every input key is still present", k >= 0 && missing.length === 0, `${missing.length} key(s) missing, e.g. "${missing[0] ?? keyColumn}".`),
    c("First row of each key kept, in order", !!out && serialize(out.rows) === serialize(wantRows.rows), "Rows differ from the first row per key in input order."),
    c("Reported counts are correct", wrongCounts.length === 0, `Wrong: ${wrongCounts.join(", ")}.`),
    c("sha256 matches the output", sha256(sub.output_csv ?? "") === sub.sha256, "The hash doesn't match the submitted output."),
  ];
}
