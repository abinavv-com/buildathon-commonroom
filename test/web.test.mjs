import test from "node:test";
import assert from "node:assert/strict";
import { buildJobRequest, parseRoute } from "../public/contracts.js";

test("reconciliation sends both files and only service input fields", () => {
  const body = buildJobRequest("books.reconcile", "ledgerly", { bank_csv: "bank", invoices_csv: "invoices", csv: "unused", title: "Match", verifiers_required: "2" });
  assert.deepEqual(body, { capability: "books.reconcile", executor: "ledgerly", inputs: { bank_csv: "bank", invoices_csv: "invoices" }, title: "Match", verifiers_required: 2 });
});
test("catalog cleaning sends its CSV and preserves a server-only policy", () => {
  assert.deepEqual(buildJobRequest("catalog.clean", "shelfwise", { csv: "products", verifiers_required: "0" }).inputs, { csv: "products" });
  assert.equal(buildJobRequest("catalog.clean", "shelfwise", { csv: "products", verifiers_required: "0" }).verifiers_required, 0);
});
test("new job and receipt routes retain the resource id", () => {
  assert.deepEqual(parseRoute("/jobs/job_123", ""), { view: "job", id: "job_123" });
  assert.deepEqual(parseRoute("/", "#agent/tidy"), { view: "agent", id: "tidy" });
  assert.deepEqual(parseRoute("/receipts/rcpt_123", ""), { view: "receipt", id: "rcpt_123" });
  assert.deepEqual(parseRoute("/claim/abc", ""), { view: "claim", id: "abc" });
});
test("lead counts become numbers and unsupported services are refused", () => {
  assert.equal(buildJobRequest("leads.extract", "prospector", { source_csv: "contacts", title_includes: "growth", count: "5", verifiers_required: "2" }).inputs.count, 5);
  assert.throws(() => buildJobRequest("arbitrary-code", "worker", {}), /Unsupported/);
});
