// Run the real tool path against live filings and report what comes out.
// Usage: npm run build && node scripts/measure.mjs [sample size, default 300]
// Needs network access to distribution.virk.dk. Not part of `npm test`.
import { getFinancials } from "../dist/virk.js";

const SEARCH_URL = "http://distribution.virk.dk/offentliggoerelser/_search";
// Large companies covering Danish GAAP, IFRS/ESEF, older IFRS, USD and group reports.
const FIXED = [
  ["54562519"], ["25313763"], ["61056416"], ["22756214"], ["24256790"],
  ["44699818"], ["44699818", undefined, "parent"],
  ["22756214", 2019], ["22756214", 2015], ["24256790", 2019],
];

const n = Number(process.argv[2] ?? 300);

// Random sample: companies that filed on eight days spread over the last year.
const cvrs = new Set();
const perDay = Math.ceil(n / 8) * 2;
for (let k = 0; k < 8 && cvrs.size < n; k++) {
  const day = new Date(Date.now() - (k * 45 + 3) * 86_400_000).toISOString().slice(0, 10);
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { range: { offentliggoerelsesTidspunkt: { gte: day, lt: `${day}T23:59:59` } } }, size: perDay }),
  });
  for (const h of (await res.json()).hits?.hits ?? []) {
    if (h._source.offentliggoerelsestype === "regnskab" && cvrs.size < n) cvrs.add(String(h._source.cvrNummer).padStart(8, "0"));
  }
}

const jobs = [...[...cvrs].map((c) => [c]), ...FIXED];
const rows = [];
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const [cvr, year, scope] = jobs[next++];
      const t = Date.now();
      try {
        const r = await getFinancials(cvr, year, scope);
        rows.push({ cvr, year, scope, ms: Date.now() - t, r });
      } catch (err) {
        rows.push({ cvr, year, scope, ms: Date.now() - t, err: err.message });
      }
    }
  }),
);

const ok = rows.filter((x) => x.r);
const count = (f) => ok.filter(f).length;
console.log(`${rows.length} lookups: ${ok.length} parsed, ${rows.filter((x) => !x.r && !x.err).length} without an XBRL annual report, ${rows.filter((x) => x.err).length} errors`);
console.log(`taxonomy: ${["danish-gaap", "ifrs", "unknown"].map((t) => `${t} ${count((x) => x.r.taxonomy === t)}`).join(", ")}`);
console.log(`group reports: ${count((x) => x.r.groupReport)}`);
console.log(`missing name ${count((x) => !x.r.name)}, missing currency ${count((x) => !x.r.currency)}`);
console.log(`balance mismatches: ${count((x) => x.r.notes.some((m) => m.includes("do not equal")))}`);
console.log(`conflicting values left empty: ${count((x) => x.r.notes.some((m) => m.includes("conflicting")))}`);
for (const key of ok[0]?.r.figures.map((f) => f.key) ?? []) {
  console.log(`  ${key.padEnd(16)} ${count((x) => x.r.figures.find((f) => f.key === key).current != null)}/${ok.length}`);
}
for (const x of rows.filter((x) => x.err)) console.log(`error ${x.cvr}: ${x.err}`);
const ms = rows.map((x) => x.ms).sort((a, b) => a - b);
console.log(`ms per lookup: p50 ${ms[ms.length >> 1]}, p95 ${ms[Math.floor(ms.length * 0.95)]}, max ${ms.at(-1)}`);
console.log("\nfixed set:");
for (const [cvr, year, scope] of FIXED) {
  const x = rows.find((y) => y.cvr === cvr && y.year === year && y.scope === scope);
  const r = x?.r;
  console.log(`  ${cvr} ${year ?? ""} ${scope ?? ""}`.padEnd(26), r ? `${r.name} | ${r.scope} | ${r.period?.end} | ${r.currency} | revenue ${r.figures[0].current} | profit ${r.figures.find((f) => f.key === "profit").current}` : x?.err ?? "not found");
}
