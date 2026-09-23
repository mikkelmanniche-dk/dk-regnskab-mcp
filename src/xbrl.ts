import { XMLParser } from "fast-xml-parser";
import { KEY_FIGURES, NS, type KeyFigure } from "./concepts.ts";

interface Context {
  id: string;
  start?: string;
  end?: string;
  instant?: string;
  entity?: string;
  // true when the context carries any dimension (explicit or typed member).
  // Dimensional facts are breakdowns (e.g. equity per share class), never totals.
  dimensional: boolean;
}

interface Fact {
  ns: string;
  name: string;
  contextRef: string;
  unitRef?: string;
  value: string;
}

export interface FigureValue {
  key: string;
  label: string;
  current: number | null;
  previous: number | null;
}

export interface Financials {
  cvr: string | null;
  name: string | null;
  reportType: string | null;
  taxonomy: "danish-gaap" | "ifrs" | "unknown";
  period: { start: string; end: string } | null;
  previousPeriod: { start: string | null; end: string | null } | null;
  currency: string | null;
  auditor: { firm: string | null; assistance: string | null };
  figures: FigureValue[];
  notes: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Every direct child of the root may repeat; keep them as arrays.
  isArray: (_name, jpath) => String(jpath).split(".").length === 2,
});

const local = (key: string) => key.slice(key.indexOf(":") + 1);
const prefixOf = (key: string) => (key.includes(":") ? key.slice(0, key.indexOf(":")) : "");

function child(node: unknown, name: string): any {
  if (!node || typeof node !== "object") return undefined;
  for (const [k, v] of Object.entries(node)) if (!k.startsWith("@_") && local(k) === name) return v;
  return undefined;
}

const text = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === "object") return text((v as any)["#text"]);
  const s = String(v).trim();
  return s === "" ? undefined : s;
};

const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);
const many = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function hasDimension(node: unknown): boolean {
  return child(node, "explicitMember") !== undefined || child(node, "typedMember") !== undefined;
}

export function parseInstance(xml: string): { contexts: Map<string, Context>; facts: Fact[]; units: Map<string, string> } {
  const doc = parser.parse(xml);
  const rootKey = Object.keys(doc).find((k) => local(k) === "xbrl");
  if (!rootKey) throw new Error("Not an XBRL instance (no <xbrl> root element)");
  const root = first(doc[rootKey]) as Record<string, any>;

  const nsByPrefix = new Map<string, string>();
  for (const [k, v] of Object.entries(root)) {
    if (k === "@_xmlns") nsByPrefix.set("", String(v));
    else if (k.startsWith("@_xmlns:")) nsByPrefix.set(k.slice(8), String(v));
  }

  const contexts = new Map<string, Context>();
  const units = new Map<string, string>();
  const facts: Fact[] = [];

  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith("@_") || key === "#text") continue;
    const ns = nsByPrefix.get(prefixOf(key)) ?? "";
    const name = local(key);

    if (ns === NS.xbrli && name === "context") {
      for (const c of many(value)) {
        const period = child(c, "period");
        const entity = child(c, "entity");
        contexts.set(c["@_id"], {
          id: c["@_id"],
          start: text(child(period, "startDate")),
          end: text(child(period, "endDate")),
          instant: text(child(period, "instant")),
          entity: text(child(entity, "identifier")),
          dimensional: hasDimension(child(c, "scenario")) || hasDimension(child(entity, "segment")),
        });
      }
      continue;
    }
    if (ns === NS.xbrli && name === "unit") {
      for (const u of many(value)) {
        const measure = text(child(u, "measure"));
        if (measure) units.set(u["@_id"], local(measure));
      }
      continue;
    }

    for (const f of many(value)) {
      if (!f || typeof f !== "object" && typeof f !== "string") continue;
      const contextRef = typeof f === "object" ? f["@_contextRef"] : undefined;
      const v = text(f);
      if (!contextRef || v === undefined) continue;
      facts.push({ ns, name, contextRef, unitRef: typeof f === "object" ? f["@_unitRef"] : undefined, value: v });
    }
  }
  return { contexts, facts, units };
}

function textFact(facts: Fact[], ns: string, name: string): string | null {
  return facts.find((f) => f.ns === ns && f.name === name)?.value ?? null;
}

function detectTaxonomy(facts: Fact[]): { taxonomy: Financials["taxonomy"]; ns: string | null } {
  if (facts.some((f) => f.ns === NS.fsa)) return { taxonomy: "danish-gaap", ns: NS.fsa };
  const ifrs = facts.find((f) => f.ns.endsWith(NS.ifrsSuffix));
  if (ifrs) return { taxonomy: "ifrs", ns: ifrs.ns };
  return { taxonomy: "unknown", ns: null };
}

// The reporting period is stated explicitly in Danish GAAP filings. ESEF filings
// don't carry it, so fall back to the latest dimensionless duration context.
function reportingPeriods(facts: Fact[], contexts: Map<string, Context>) {
  const start = textFact(facts, NS.gsd, "ReportingPeriodStartDate");
  const end = textFact(facts, NS.gsd, "ReportingPeriodEndDate");
  // "Preding" is the taxonomy's own spelling of the preceding end-date concept.
  const prevStart = textFact(facts, NS.gsd, "PrecedingReportingPeriodStartDate");
  const prevEnd =
    textFact(facts, NS.gsd, "PrecedingReportingPeriodEndDate") ?? textFact(facts, NS.gsd, "PredingReportingPeriodEndDate");

  const durations = [...contexts.values()]
    .filter((c) => !c.dimensional && c.start && c.end)
    .sort((a, b) => b.end!.localeCompare(a.end!));

  const current = start && end ? { start, end } : durations[0] ? { start: durations[0].start!, end: durations[0].end! } : null;
  if (!current) return { current: null, previous: null };

  let previous: { start: string | null; end: string | null } | null =
    prevStart || prevEnd ? { start: prevStart, end: prevEnd } : null;
  if (!previous) {
    const prior = durations.find((c) => c.end! < current.end && c.end! <= current.start);
    previous = prior ? { start: prior.start!, end: prior.end! } : null;
  }
  return { current, previous };
}

function pick(
  figure: KeyFigure,
  names: string[],
  ns: string,
  facts: Fact[],
  contexts: Map<string, Context>,
  period: { start: string | null; end: string | null } | null,
  notes: string[],
  which: string,
): number | null {
  if (!period?.end) return null;
  for (const name of names) {
    const values = new Set<number>();
    for (const f of facts) {
      if (f.ns !== ns || f.name !== name) continue;
      const c = contexts.get(f.contextRef);
      if (!c || c.dimensional) continue;
      const matches =
        figure.period === "instant"
          ? c.instant === period.end
          : c.end === period.end && (period.start == null || c.start === period.start);
      if (!matches) continue;
      const n = Number(f.value);
      if (Number.isFinite(n)) values.add(n);
    }
    if (values.size === 1) return [...values][0]!;
    if (values.size > 1) {
      // Seen in real filings: 0 and 1 employees reported for the same period.
      // Guessing would be worse than admitting it.
      notes.push(`${figure.label} (${which}): the filing reports conflicting values (${[...values].join(", ")}) — left empty.`);
      return null;
    }
  }
  return null;
}

export function extractFinancials(xml: string): Financials {
  const { contexts, facts, units } = parseInstance(xml);
  const notes: string[] = [];
  const { taxonomy, ns } = detectTaxonomy(facts);
  const { current, previous } = reportingPeriods(facts, contexts);

  const currencyUnits = new Set(
    facts
      .filter((f) => f.unitRef && ns && f.ns === ns)
      .map((f) => units.get(f.unitRef!))
      .filter((u): u is string => !!u && u !== "pure" && u !== "shares"),
  );
  if (currencyUnits.size > 1) notes.push(`Several currencies in the filing: ${[...currencyUnits].join(", ")}.`);

  const figures: FigureValue[] = KEY_FIGURES.map((fig) => {
    const names = taxonomy === "ifrs" ? fig.ifrs : fig.fsa;
    return {
      key: fig.key,
      label: fig.label,
      current: ns ? pick(fig, names, ns, facts, contexts, current, notes, "current") : null,
      previous: ns ? pick(fig, names, ns, facts, contexts, previous, notes, "previous") : null,
    };
  });

  if (taxonomy === "danish-gaap" && figures.find((f) => f.key === "revenue")?.current == null) {
    notes.push("No revenue figure: most small Danish companies (reporting class B) may legally omit revenue and report gross profit instead.");
  }

  return {
    cvr: textFact(facts, NS.gsd, "IdentificationNumberCvrOfReportingEntity") ?? [...contexts.values()][0]?.entity ?? null,
    // ESEF filings name the company in the IFRS taxonomy instead of gsd.
    name:
      textFact(facts, NS.gsd, "NameOfReportingEntity") ??
      facts.find((f) => f.ns.endsWith(NS.ifrsSuffix) && f.name === "NameOfReportingEntityOrOtherMeansOfIdentification")?.value ??
      null,
    reportType: textFact(facts, NS.gsd, "InformationOnTypeOfSubmittedReport"),
    taxonomy,
    period: current,
    previousPeriod: previous,
    currency: currencyUnits.size === 1 ? [...currencyUnits][0]! : null,
    auditor: {
      firm: textFact(facts, NS.cmn, "NameOfAuditFirm"),
      assistance: textFact(facts, NS.cmn, "TypeOfAuditorAssistance"),
    },
    figures,
    notes,
  };
}

// How many key figures a document yields — used to choose between the several
// XML documents a filing can contain (the file named "AARSRAPPORT" is not
// always the one holding the numbers).
export function score(f: Financials): number {
  return f.figures.reduce((n, x) => n + (x.current != null ? 1 : 0), 0);
}
