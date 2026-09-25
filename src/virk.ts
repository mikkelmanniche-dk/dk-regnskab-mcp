import { gunzipSync } from "node:zlib";
import { extractFacts, extractFinancials, score, type Financials, type ReportFact, type Scope } from "./xbrl.ts";

// The Danish Business Authority's open filing index. It only answers over plain
// HTTP (port 443 times out), so this must run server-side, never in a browser.
const SEARCH_URL = "http://distribution.virk.dk/offentliggoerelser/_search";
const USER_AGENT = "dk-regnskab-mcp/0.3 (+https://github.com/mikkelmanniche-dk/dk-regnskab-mcp)";
const TIMEOUT_MS = 20_000;

export interface Filing {
  cvr: string;
  type: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  publishedAt: string | null;
  correction: boolean;
  documents: { type: string; mimeType: string; url: string }[];
}

export function normalizeCvr(input: string): string {
  const cvr = input.replace(/\s|-/g, "").replace(/^DK/i, "");
  if (!/^\d{8}$/.test(cvr)) throw new Error(`"${input}" is not a CVR number (8 digits).`);
  return cvr;
}

export async function get(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res;
}

export async function listFilings(cvrInput: string, limit = 10, periodEndYear?: number): Promise<Filing[]> {
  const cvr = normalizeCvr(cvrInput);
  // Filter by period in the index itself: listed companies publish 4-5 filings
  // a year, so an older annual report can sit far down the plain list.
  const byCvr = { term: { cvrNummer: Number(cvr) } };
  const query = periodEndYear
    ? {
        bool: {
          filter: [
            byCvr,
            { range: { "regnskab.regnskabsperiode.slutDato": { gte: `${periodEndYear}-01-01`, lte: `${periodEndYear}-12-31` } } },
          ],
        },
      }
    : byCvr;
  const res = await get(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      size: limit,
      sort: [{ offentliggoerelsesTidspunkt: { order: "desc" } }],
    }),
  });
  const body = (await res.json()) as any;
  return (body?.hits?.hits ?? []).map((h: any): Filing => {
    const s = h._source ?? {};
    return {
      cvr,
      type: s.offentliggoerelsestype ?? null,
      periodStart: s.regnskab?.regnskabsperiode?.startDato ?? null,
      periodEnd: s.regnskab?.regnskabsperiode?.slutDato ?? null,
      publishedAt: s.offentliggoerelsesTidspunkt ?? null,
      correction: !!s.omgoerelse,
      documents: (s.dokumenter ?? []).map((d: any) => ({ type: d.dokumentType, mimeType: d.dokumentMimeType, url: d.dokumentUrl })),
    };
  });
}

// Documents are often gzip-compressed without a Content-Encoding header, so
// check the magic bytes instead of trusting the response.
export async function downloadText(url: string): Promise<string> {
  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return raw.toString("utf8");
}

// Interim filings sometimes carry an AARSRAPPORT_ESEF document too (seen at
// Maersk in 2021), so an interim document type rules the filing out.
const isAnnualReport = (f: Filing) =>
  f.type === "regnskab" &&
  f.documents.some((d) => d.type.startsWith("AARSRAPPORT") && d.mimeType === "application/xml") &&
  !f.documents.some((d) => d.type === "DELAARSRAPPORT" || d.type === "HALVAARSRAPPORT");

export interface FinancialsResult extends Financials {
  source: { publishedAt: string | null; documentType: string; url: string };
}

// A filing can hold several XML documents (Danish GAAP, ESEF, extensions).
// Pick the one that actually yields the most key figures.
async function readFiling(filing: Filing, scope: Scope): Promise<{ financials: FinancialsResult; xml: string } | null> {
  let best: { financials: FinancialsResult; xml: string } | null = null;
  const siblings: Financials[] = [];
  for (const doc of filing.documents.filter((d) => d.mimeType === "application/xml" && d.type.startsWith("AARSRAPPORT"))) {
    try {
      const xml = await downloadText(doc.url);
      const parsed = extractFinancials(xml, scope);
      siblings.push(parsed);
      if (!best || score(parsed) > score(best.financials)) {
        best = { financials: { ...parsed, source: { publishedAt: filing.publishedAt, documentType: doc.type, url: doc.url } }, xml };
      }
    } catch {
      // A malformed document shouldn't hide a good sibling; try the next one.
    }
  }
  if (!best) return null;
  // The document with the figures doesn't always carry the company details
  // (seen in ESEF filings); take them from a sibling document of the same filing.
  const f = best.financials;
  for (const other of siblings) {
    f.cvr ??= other.cvr;
    f.name ??= other.name;
    f.reportType ??= other.reportType;
    f.auditor.firm ??= other.auditor.firm;
    f.auditor.assistance ??= other.auditor.assistance;
  }
  if (filing.correction) f.notes.push("This filing is a correction (omgørelse) of an earlier one.");
  return best;
}

async function findAnnualReport(cvrInput: string, periodEndYear?: number): Promise<Filing | undefined> {
  const filings = (await listFilings(cvrInput, 30, periodEndYear)).filter(isAnnualReport);
  return periodEndYear ? filings.find((f) => f.periodEnd?.startsWith(String(periodEndYear))) : filings[0];
}

export async function getFinancials(cvrInput: string, periodEndYear?: number, scope: Scope = "group"): Promise<FinancialsResult | null> {
  const filing = await findAnnualReport(cvrInput, periodEndYear);
  return filing ? ((await readFiling(filing, scope))?.financials ?? null) : null;
}

export interface HistoryYear {
  period: { start: string; end: string } | null;
  currency: string | null;
  scope: Financials["scope"];
  figures: Record<string, number | null>;
  notes: string[];
  source: FinancialsResult["source"];
}

// One annual report per reporting period, newest first. A corrected report
// (omgørelse) is published later than the original, so the first one seen wins.
export async function getFinancialsHistory(cvrInput: string, years = 5, scope: Scope = "group"): Promise<{ name: string | null; years: HistoryYear[] }> {
  // Listed companies file 4-5 times a year, so look far enough back for 15 years.
  const filings = (await listFilings(cvrInput, 300)).filter(isAnnualReport);
  const byPeriod = new Map<string, Filing>();
  for (const f of filings) if (f.periodEnd && !byPeriod.has(f.periodEnd)) byPeriod.set(f.periodEnd, f);
  const chosen = [...byPeriod.values()].sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!)).slice(0, years);

  // A few at a time: each filing means one to three downloads from a public server.
  const results: Awaited<ReturnType<typeof readFiling>>[] = [];
  for (let i = 0; i < chosen.length; i += 3) {
    results.push(...(await Promise.all(chosen.slice(i, i + 3).map((f) => readFiling(f, scope)))));
  }
  const out: HistoryYear[] = [];
  let name: string | null = null;
  for (const r of results) {
    if (!r) continue;
    const f = r.financials;
    name ??= f.name;
    out.push({
      period: f.period,
      currency: f.currency,
      scope: f.scope,
      figures: Object.fromEntries(f.figures.map((x) => [x.key, x.current])),
      notes: f.notes,
      source: f.source,
    });
  }
  return { name, years: out };
}

export async function getReportFacts(
  cvrInput: string,
  periodEndYear: number | undefined,
  scope: Scope,
  match: string | undefined,
  limit: number,
): Promise<{ financials: FinancialsResult; total: number; facts: ReportFact[] } | null> {
  const filing = await findAnnualReport(cvrInput, periodEndYear);
  const read = filing ? await readFiling(filing, scope) : null;
  if (!read) return null;
  const needle = match?.toLowerCase();
  const all = extractFacts(read.xml, scope).facts.filter((f) => !needle || f.concept.toLowerCase().includes(needle));
  return { financials: read.financials, total: all.length, facts: all.slice(0, limit) };
}
