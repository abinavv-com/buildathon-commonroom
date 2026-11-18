// Two more back-office services the server can check exactly:
//   books.reconcile  match invoices to bank lines (bookkeeping)
//   catalog.clean    normalise a product feed (e-commerce)
// Each has a reference implementation; the server re-derives the answer and compares, then explains any difference.
import { sha256, table, serialize } from "./csv.mjs";

const cents = (v) => { const n = Number(String(v).replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const col = (t, name) => { const i = t.header.indexOf(name); if (i < 0) throw new Error(`Missing column "${name}". Columns: ${t.header.join(", ")}.`); return i; };
const c = (label, passed, detail) => ({ label, passed, detail: passed ? "" : detail });

// ---------- books.reconcile ----------
export const RECON_COLUMNS = ["invoice_id", "customer", "amount", "status", "bank_date", "bank_description"];
export function reconcile({ bank_csv, invoices_csv }) {
  const bank = table(bank_csv), inv = table(invoices_csv);
  const [bd, bdesc, bamt] = ["date", "description", "amount"].map((n) => col(bank, n));
  const [iid, icust, iamt] = ["invoice_id", "customer", "amount"].map((n) => col(inv, n));
  const used = new Set();
  const rows = inv.rows.map((r) => {
    const amt = cents(r[iamt]);
    const k = bank.rows.findIndex((b, i) => !used.has(i) && cents(b[bamt]) === amt);
    if (k >= 0) used.add(k);
    return [r[iid], r[icust], (amt / 100).toFixed(2), k >= 0 ? "matched" : "unmatched", k >= 0 ? bank.rows[k][bd] : "", k >= 0 ? bank.rows[k][bdesc] : ""];
  });
  const output_csv = serialize([RECON_COLUMNS, ...rows]);
  const matched = rows.filter((r) => r[3] === "matched").length;
  return { output_csv, sha256: sha256(output_csv), summary: { invoices: rows.length, matched, unmatched: rows.length - matched }, claim: `Done. ${matched} of ${rows.length} invoices matched to the bank.` };
}
export function checkReconcile(inputs, sub) {
  const want = reconcile(inputs), wantT = table(want.output_csv);
  const bank = table(inputs.bank_csv);
  let out = null, why = "";
  try { out = table(sub.output_csv ?? ""); for (const n of RECON_COLUMNS) col(out, n); } catch (e) { why = e.message; out = null; }
  const ids = out ? out.rows.map((r) => r[col(out, "invoice_id")]) : [];
  const wantIds = wantT.rows.map((r) => r[0]);
  const bankKey = (d, desc) => `${d}|${desc}`;
  const bankLines = new Map(bank.rows.map((b) => [bankKey(b[col(bank, "date")], b[col(bank, "description")]), cents(b[col(bank, "amount")])]));
  const matchedRows = out ? out.rows.filter((r) => r[col(out, "status")] === "matched") : [];
  const badMatch = matchedRows.filter((r) => bankLines.get(bankKey(r[col(out, "bank_date")], r[col(out, "bank_description")])) !== cents(r[col(out, "amount")]));
  const usedTwice = matchedRows.length - new Set(matchedRows.map((r) => bankKey(r[col(out, "bank_date")], r[col(out, "bank_description")]))).size;
  const total = (t, status) => t.rows.filter((r) => !status || r[3] === status).reduce((s, r) => s + cents(r[2]), 0);
  return [
    c("Output is valid CSV with the reconciliation columns", !!out, why),
    c("Every invoice appears exactly once", !!out && ids.length === wantIds.length && new Set(ids).size === ids.length && wantIds.every((i) => ids.includes(i)), "Invoices are missing or repeated."),
    c("Every match points to a real bank line with the same amount", !!out && badMatch.length === 0, `${badMatch.length} match(es) don't agree with the bank statement.`),
    c("No bank line is used twice", !!out && usedTwice === 0, `${usedTwice} bank line(s) were matched more than once.`),
    c("Nothing matchable was left unmatched", !!out && matchedRows.length === want.summary.matched, `Matched ${matchedRows.length}; ${want.summary.matched} can be matched.`),
    c("Totals reconcile", !!out && total(out) === total(wantT) && total(out, "matched") === total(wantT, "matched"), "Matched and unmatched totals don't add up to the invoices."),
    c("sha256 matches the output", sha256(sub.output_csv ?? "") === sub.sha256, "The hash doesn't match the submitted output."),
  ];
}
export const SAMPLE_BOOKS = {
  bank_csv: "date,description,amount\n2026-11-02,STRIPE PAYOUT ACME,1250.00\n2026-11-03,WIRE NORTHWIND LTD,480.00\n2026-11-05,CARD SETTLEMENT,99.90\n2026-11-06,WIRE BLUEBARN,2300.00\n2026-11-08,REFUND,-45.00",
  invoices_csv: "invoice_id,customer,amount\nINV-1041,Acme Co,1250.00\nINV-1042,Northwind,480.00\nINV-1043,Fernhill,760.00\nINV-1044,Bluebarn,2300.00",
};

// ---------- catalog.clean ----------
export const CATALOG_COLUMNS = ["sku", "title", "price", "stock"];
export function cleanCatalog({ csv }) {
  const t = table(csv);
  const [s, ti, p, st] = CATALOG_COLUMNS.map((n) => col(t, n));
  const seen = new Set(), rows = [];
  for (const r of t.rows) {
    const sku = r[s].trim().toUpperCase();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const price = cents(r[p]);
    const stock = Math.max(0, parseInt(String(r[st]).replace(/[^0-9-]/g, ""), 10) || 0);
    rows.push([sku, r[ti].trim().replace(/\s+/g, " "), Number.isFinite(price) && price >= 0 ? (price / 100).toFixed(2) : "0.00", String(stock)]);
  }
  const output_csv = serialize([CATALOG_COLUMNS, ...rows]);
  return { output_csv, sha256: sha256(output_csv), summary: { input_rows: t.rows.length, output_rows: rows.length, removed: t.rows.length - rows.length }, claim: `Done. ${rows.length} products cleaned, ${t.rows.length - rows.length} duplicates removed.` };
}
export function checkCatalog(inputs, sub) {
  const want = cleanCatalog(inputs), wantT = table(want.output_csv);
  let out = null, why = "";
  try { out = table(sub.output_csv ?? ""); for (const n of CATALOG_COLUMNS) col(out, n); } catch (e) { why = e.message; out = null; }
  const skus = out ? out.rows.map((r) => r[col(out, "sku")]) : [];
  const wantSkus = wantT.rows.map((r) => r[0]);
  const prices = out ? out.rows.map((r) => r[col(out, "price")]) : [];
  const titles = out ? out.rows.map((r) => r[col(out, "title")]) : [];
  const same = out && serialize(out.rows) === serialize(wantT.rows);
  return [
    c("Output is valid CSV with sku, title, price, stock", !!out, why),
    c("SKUs are unique and uppercase", !!out && new Set(skus).size === skus.length && skus.every((x) => x === x.toUpperCase()), "Duplicate or lowercase SKUs remain."),
    c("Every product from the feed is still there", !!out && wantSkus.every((x) => skus.includes(x)) && skus.every((x) => wantSkus.includes(x)), "Products were dropped or invented."),
    c("Prices look like 12.50", !!out && prices.every((x) => /^\d+\.\d{2}$/.test(x)), "Some prices aren't formatted as 0.00."),
    c("Titles are trimmed and not empty", !!out && titles.every((x) => x && x === x.trim() && !/\s{2,}/.test(x)), "Some titles are empty or have stray spaces."),
    c("Values match the source after cleanup", !!same, "Some values differ from the cleaned source."),
    c("sha256 matches the output", sha256(sub.output_csv ?? "") === sub.sha256, "The hash doesn't match the submitted output."),
  ];
}
export const SAMPLE_CATALOG = { csv: "sku,title,price,stock\nmug-01,  Ceramic mug,  $12.5,40\nMUG-01,Ceramic mug (dup),12.50,40\ntee-blk,Black   tee,\"1,299.00\",7\ncap-02,Canvas cap,19,-3\npin-11,Enamel pin,4.5,120" };
