import { gunzipSync } from "node:zlib";
import { extractFinancials, score, type Financials } from "./xbrl.ts";

// The Danish Business Authority's open filing index. It only answers over plain
// HTTP (port 443 times out), so this must run server-side, never in a browser.
const SEARCH_URL = "http://distribution.virk.dk/offentliggoerelser/_search";
const USER_AGENT = "dk-regnskab-mcp/0.1 (+https://github.com/mikkelmanniche-dk/dk-regnskab-mcp)";
const TIMEOUT_MS = 20_000;

export interface Filing {
  cvr: string;
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
  publishedAt: string;
  correction: boolean;
  documents: { type: string; mimeType: string; url: string }[];
}

export function normalizeCvr(input: string): string {
  const cvr = input.replace(/\s|-/g, "").replace(/^DK/i, "");
  if (!/^\d{8}$/.test(cvr)) throw new Error(`"${input}" is not a CVR number (8 digits).`);
  return cvr;
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res;
}

export async function listFilings(cvrInput: string, limit = 10): Promise<Filing[]> {
  const cvr = normalizeCvr(cvrInput);
  const res = await get(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: { term: { cvrNummer: Number(cvr) } },
      size: limit,
      sort: [{ offentliggoerelsesTidspunkt: { order: "desc" } }],
    }),
  });
  const body = (await res.json()) as any;
  return (body?.hits?.hits ?? []).map((h: any): Filing => {
    const s = h._source ?? {};
    return {
      cvr,
      type: s.offentliggoerelsestype,
      periodStart: s.regnskab?.regnskabsperiode?.startDato ?? null,
      periodEnd: s.regnskab?.regnskabsperiode?.slutDato ?? null,
      publishedAt: s.offentliggoerelsesTidspunkt,
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

const isAnnualReport = (f: Filing) =>
  f.type === "regnskab" && f.documents.some((d) => d.type.startsWith("AARSRAPPORT") && d.mimeType === "application/xml");

export interface FinancialsResult extends Financials {
  source: { publishedAt: string; documentType: string; url: string };
}

export async function getFinancials(cvrInput: string, periodEndYear?: number): Promise<FinancialsResult | null> {
  const filings = (await listFilings(cvrInput, 30)).filter(isAnnualReport);
  const filing = periodEndYear
    ? filings.find((f) => f.periodEnd?.startsWith(String(periodEndYear)))
    : filings[0];
  if (!filing) return null;

  // A filing can hold several XML documents (Danish GAAP, ESEF, extensions).
  // Pick the one that actually yields the most key figures.
  let best: FinancialsResult | null = null;
  for (const doc of filing.documents.filter((d) => d.mimeType === "application/xml" && d.type.startsWith("AARSRAPPORT"))) {
    try {
      const parsed = extractFinancials(await downloadText(doc.url));
      if (!best || score(parsed) > score(best)) {
        best = { ...parsed, source: { publishedAt: filing.publishedAt, documentType: doc.type, url: doc.url } };
      }
    } catch {
      // A malformed document shouldn't hide a good sibling; try the next one.
    }
  }
  if (best && filing.correction) best.notes.push("This filing is a correction (omgørelse) of an earlier one.");
  return best;
}
