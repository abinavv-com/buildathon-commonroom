import test from "node:test";
import assert from "node:assert/strict";
import { check, dedupe, parse } from "../lib/csv.mjs";

const CSV = 'url,title\nhttps://a.org/x,A\n"https://A.org/x/ ","A, again"\nhttps://b.org,B\n';

test("parse handles quotes, commas and CRLF", () => {
  assert.deepEqual(parse('a,b\r\n"x,""y""",z'), [["a", "b"], ['x,"y"', "z"]]);
});

test("dedupe keeps the first row per normalised key", () => {
  const r = dedupe(CSV, "url");
  assert.equal(r.output_csv, "url,title\nhttps://a.org/x,A\nhttps://b.org,B");
  assert.deepEqual(r.summary, { input_rows: 3, output_rows: 2, removed: 1 });
});

test("an honest result passes every check; a tampered one fails", () => {
  const honest = dedupe(CSV, "url");
  assert.ok(check(CSV, "url", honest).every((c) => c.passed));
  const tampered = { ...honest, output_csv: honest.output_csv.replace("B", "b") };
  const failed = check(CSV, "url", tampered).filter((c) => !c.passed).map((c) => c.label);
  assert.deepEqual(failed, ["First row of each key kept, in order", "sha256 matches the output"]);
});
