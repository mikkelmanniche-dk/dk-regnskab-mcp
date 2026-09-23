import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractFinancials } from "../src/xbrl.ts";
import { normalizeCvr } from "../src/virk.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const figure = (f: ReturnType<typeof extractFinancials>, key: string) => f.figures.find((x) => x.key === key)!;

test("Danish GAAP: reads entity, periods and auditor regardless of namespace prefixes", () => {
  const f = extractFinancials(fixture("danish-gaap.xml"));
  assert.equal(f.taxonomy, "danish-gaap");
  assert.equal(f.cvr, "12345678");
  assert.equal(f.name, "Eksempel ApS");
  assert.equal(f.currency, "DKK");
  assert.deepEqual(f.period, { start: "2025-01-01", end: "2025-12-31" });
  // The taxonomy spells it "PredingReportingPeriodEndDate".
  assert.deepEqual(f.previousPeriod, { start: "2024-01-01", end: "2024-12-31" });
  assert.equal(f.auditor.firm, "Revisor & Co");
});

test("Danish GAAP: dimensional facts never replace the total", () => {
  const f = extractFinancials(fixture("danish-gaap.xml"));
  // The share-capital breakdown (80,000) must not be reported as equity.
  assert.deepEqual(figure(f, "equity"), { key: "equity", label: figure(f, "equity").label, current: 6002479, previous: 6152479 });
  // A per-board-member fact must not shadow the company's profit.
  assert.equal(figure(f, "profit").current, -150000);
  assert.equal(figure(f, "profit").previous, 320000);
});

test("Danish GAAP: conflicting values are left empty with a note, not guessed", () => {
  const f = extractFinancials(fixture("danish-gaap.xml"));
  assert.equal(figure(f, "employees").current, null);
  assert.equal(figure(f, "employees").previous, 2);
  assert.ok(f.notes.some((n) => n.includes("conflicting values (0, 1)")));
});

test("Danish GAAP: missing revenue is explained", () => {
  const f = extractFinancials(fixture("danish-gaap.xml"));
  assert.equal(figure(f, "revenue").current, null);
  assert.equal(figure(f, "grossProfit").current, 2500000);
  assert.ok(f.notes.some((n) => n.includes("class B")));
});

test("IFRS/ESEF: infers periods from contexts and reads IFRS concepts", () => {
  const f = extractFinancials(fixture("ifrs.xml"));
  assert.equal(f.taxonomy, "ifrs");
  assert.equal(f.name, "Example A/S");
  assert.equal(f.currency, "EUR");
  assert.deepEqual(f.period, { start: "2025-01-01", end: "2025-12-31" });
  assert.equal(figure(f, "revenue").current, 120000000);
  assert.equal(figure(f, "revenue").previous, 110000000);
  assert.equal(figure(f, "equity").current, 45000000);
});

test("rejects input that isn't an XBRL instance", () => {
  assert.throws(() => extractFinancials("<html><body>nope</body></html>"), /Not an XBRL instance/);
});

test("normalizeCvr accepts common spellings and rejects the rest", () => {
  assert.equal(normalizeCvr("DK 1234 5678"), "12345678");
  assert.equal(normalizeCvr("12-34-56-78"), "12345678");
  assert.throws(() => normalizeCvr("1234"), /not a CVR number/);
});
