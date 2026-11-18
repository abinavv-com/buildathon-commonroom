import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, checkReconcile, cleanCatalog, checkCatalog, SAMPLE_BOOKS, SAMPLE_CATALOG } from "../lib/ops.mjs";
import { sha256 } from "../lib/csv.mjs";

const failed = (inputs, output_csv) => checkReconcile(inputs, { output_csv, sha256: sha256(output_csv) }).filter((c) => !c.passed);

test("reconciliation preserves invoice identity, customer and per-invoice amounts", () => {
  const good = reconcile(SAMPLE_BOOKS);
  for (const output of [
    good.output_csv.replace("Acme Co", "Invented customer"),
    good.output_csv.replace("1250.00,matched", "480.00,matched").replace("480.00,matched,2026-11-03", "1250.00,matched,2026-11-03"),
    good.output_csv.replace("760.00,unmatched", "760.00,invented"),
  ]) assert.ok(failed(SAMPLE_BOOKS, output).length, output);
});

test("separate bank rows may share a date and description", () => {
  const inputs = {
    bank_csv: "date,description,amount\n2026-11-01,Payment,10\n2026-11-01,Payment,20\n2026-11-01,Payment,10",
    invoices_csv: "invoice_id,customer,amount\nI1,A,10\nI2,B,20\nI3,C,10",
  };
  const result = reconcile(inputs);
  assert.deepEqual(result.summary, { invoices: 3, matched: 3, unmatched: 0 });
  assert.deepEqual(failed(inputs, result.output_csv), []);
});

test("one bank row cannot satisfy two invoices", () => {
  const inputs = { bank_csv: "date,description,amount\n2026-11-01,Payment,10", invoices_csv: "invoice_id,customer,amount\nI1,A,10\nI2,B,10" };
  const output = "invoice_id,customer,amount,status,bank_date,bank_description\nI1,A,10.00,matched,2026-11-01,Payment\nI2,B,10.00,matched,2026-11-01,Payment";
  assert.ok(failed(inputs, output).some((c) => c.label === "No bank line is used twice"));
});

test("sample reconciliation has a fixed result and passes every check", () => {
  const result = reconcile(SAMPLE_BOOKS);
  assert.deepEqual(result.summary, { invoices: 4, matched: 3, unmatched: 1 });
  assert.deepEqual(failed(SAMPLE_BOOKS, result.output_csv), []);
});

test("catalog cleanup preserves source values and rejects a changed price", () => {
  const result = cleanCatalog(SAMPLE_CATALOG);
  assert.equal(result.output_csv, "sku,title,price,stock\nMUG-01,Ceramic mug,12.50,40\nTEE-BLK,Black tee,1299.00,7\nCAP-02,Canvas cap,19.00,0\nPIN-11,Enamel pin,4.50,120");
  assert.ok(checkCatalog(SAMPLE_CATALOG, result).every((c) => c.passed));
  const output_csv = result.output_csv.replace("12.50", "99.00");
  assert.ok(checkCatalog(SAMPLE_CATALOG, { output_csv, sha256: sha256(output_csv) }).some((c) => !c.passed));
});
