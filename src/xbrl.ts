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
  // Which entity the context describes. Group reports tag either the group's
  // or the parent's figures with a consolidated/solo dimension; everything
  // else with a dimension is a breakdown.
  role: Role;
}

type Role = "plain" | "consolidated" | "solo" | "breakdown";
export type Scope = "group" | "parent";

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
  // "group" when the figures are the consolidated group's, "parent" when they
  // are the parent company's own in a group report, "company" otherwise.
  scope: "group" | "parent" | "company";
  groupReport: boolean;
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

// Danish GAAP and IFRS name the group-vs-parent dimension differently.
const CONSOLIDATION_DIMENSIONS = new Set(["ConsolidatedSoloDimension", "ConsolidatedAndSeparateFinancialStatementsAxis"]);
const SOLO_MEMBERS = new Set(["SoloMember", "SeparateMember"]);

function dimensions(node: unknown): { dimension: string; member: string | null }[] {
  const out: { dimension: string; member: string | null }[] = [];
  for (const m of many(child(node, "explicitMember"))) {
    out.push({ dimension: local(String((m as any)?.["@_dimension"] ?? "")), member: local(text(m) ?? "") });
  }
  for (const m of many(child(node, "typedMember"))) {
    out.push({ dimension: local(String((m as any)?.["@_dimension"] ?? "")), member: null });
  }
  return out;
}

function roleOf(dims: { dimension: string; member: string | null }[]): Role {
  if (dims.length === 0) return "plain";
  const [d] = dims;
  if (dims.length === 1 && d && CONSOLIDATION_DIMENSIONS.has(d.dimension)) {
    if (d.member === "ConsolidatedMember") return "consolidated";
    if (d.member && SOLO_MEMBERS.has(d.member)) return "solo";
  }
  return "breakdown";
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
        const dims = [...dimensions(child(c, "scenario")), ...dimensions(child(entity, "segment"))];
        contexts.set(c["@_id"], {
          id: c["@_id"],
          start: text(child(period, "startDate")),
          end: text(child(period, "endDate")),
          instant: text(child(period, "instant")),
          entity: text(child(entity, "identifier")),
          dimensional: dims.length > 0,
          role: roleOf(dims),
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

// Some filers put formatting markup inside text facts (seen: a whole HTML
// table around the company name).
const cleanText = (v: string) => v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function textFact(facts: Fact[], ns: string, name: string): string | null {
  const v = facts.find((f) => f.ns === ns && f.name === name)?.value;
  return v == null ? null : cleanText(v) || null;
}

const isIfrsNs = (ns: string) => ns.endsWith(NS.ifrsSuffix) || NS.ifrsLegacy.test(ns);

function detectTaxonomy(facts: Fact[]): { taxonomy: Financials["taxonomy"]; ns: string | null } {
  if (facts.some((f) => f.ns === NS.fsa)) return { taxonomy: "danish-gaap", ns: NS.fsa };
  const ifrs = facts.find((f) => isIfrsNs(f.ns));
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
    // Same end date: the longest period wins. Annual reports can also tag the
    // last quarter (seen at Maersk 2020: Q4 and full year both end 31 December).
    .sort((a, b) => b.end!.localeCompare(a.end!) || a.start!.localeCompare(b.start!));

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

interface Source {
  ns: string;
  names: string[];
}

function pick(
  figure: Pick<KeyFigure, "label" | "period">,
  sources: Source[],
  facts: Fact[],
  contexts: Map<string, Context>,
  period: { start: string | null; end: string | null } | null,
  notes: string[],
  which: string,
  role: Role,
  usedUnits?: Set<string>,
): number | null {
  if (!period?.end) return null;
  for (const { ns, name } of sources.flatMap((s) => s.names.map((name) => ({ ns: s.ns, name })))) {
    const values = new Set<number>();
    const units = new Set<string>();
    for (const f of facts) {
      if (f.ns !== ns || f.name !== name) continue;
      const c = contexts.get(f.contextRef);
      if (!c || c.role !== role) continue;
      const matches =
        figure.period === "instant"
          ? c.instant === period.end
          : c.end === period.end && (period.start == null || c.start === period.start);
      if (!matches) continue;
      const n = Number(f.value);
      if (Number.isFinite(n)) {
        values.add(n);
        if (f.unitRef) units.add(f.unitRef);
      }
    }
    if (values.size === 1) {
      for (const u of units) usedUnits?.add(u);
      return [...values][0]!;
    }
    if (values.size > 1) {
      // Seen in real filings: 0 and 1 employees reported for the same period.
      // Guessing would be worse than admitting it.
      notes.push(`${figure.label} (${which}): the filing reports conflicting values (${[...values].join(", ")}) — left empty.`);
      return null;
    }
  }
  return null;
}

// In a group report one entity's figures are tagged with a consolidation
// dimension and the other's are plain. Danish filings usually tag the group
// (plain = parent); IFRS tags the parent (plain = group).
function scopeRole(contexts: Map<string, Context>, scope: Scope): { groupReport: boolean; role: Role } {
  const roles = new Set([...contexts.values()].map((c) => c.role));
  const groupReport = roles.has("consolidated") || roles.has("solo");
  const groupRole: Role = roles.has("consolidated") ? "consolidated" : "plain";
  const parentRole: Role = roles.has("solo") ? "solo" : "plain";
  return { groupReport, role: !groupReport ? "plain" : scope === "parent" ? parentRole : groupRole };
}

export function extractFinancials(xml: string, scope: Scope = "group"): Financials {
  const { contexts, facts, units } = parseInstance(xml);
  const notes: string[] = [];
  const { taxonomy, ns } = detectTaxonomy(facts);
  const { current, previous } = reportingPeriods(facts, contexts);

  const { groupReport, role } = scopeRole(contexts, scope);
  if (groupReport) {
    notes.push(
      scope === "parent"
        ? "Group report: these are the parent company's own figures. Use scope \"group\" for the consolidated group."
        : "Group report: these are the consolidated group's figures. Use scope \"parent\" for the parent company alone.",
    );
  }

  const dkNs = facts.find((f) => f.ns.includes(NS.ifrsDkMarker))?.ns;
  const sourcesFor = (fig: KeyFigure): Source[] => {
    if (!ns) return [];
    if (taxonomy !== "ifrs") return [{ ns, names: fig.fsa }];
    return dkNs && fig.ifrsDk ? [{ ns, names: fig.ifrs }, { ns: dkNs, names: fig.ifrsDk }] : [{ ns, names: fig.ifrs }];
  };

  // The currency is whatever unit the reported figures actually use. A filing
  // may mention other currencies elsewhere (Maersk: USD statements, a few DKK facts).
  const usedUnits = new Set<string>();
  const figures: FigureValue[] = KEY_FIGURES.map((fig) => ({
    key: fig.key,
    label: fig.label,
    current: pick(fig, sourcesFor(fig), facts, contexts, current, notes, "current", role, usedUnits),
    previous: pick(fig, sourcesFor(fig), facts, contexts, previous, notes, "previous", role, usedUnits),
  }));
  const currencyUnits = new Set(
    [...usedUnits].map((u) => units.get(u)).filter((u): u is string => !!u && u !== "pure" && u !== "shares"),
  );
  if (currencyUnits.size > 1) notes.push(`The key figures use several currencies: ${[...currencyUnits].join(", ")}.`);

  // Sanity check: total assets must equal total liabilities and equity.
  const assets = figures.find((f) => f.key === "assets")?.current;
  const balance = ns
    ? pick({ label: "Passiver i alt / Liabilities and equity", period: "instant" }, [{ ns, names: taxonomy === "ifrs" ? ["EquityAndLiabilities"] : ["LiabilitiesAndEquity"] }], facts, contexts, current, [], "current", role)
    : null;
  if (assets != null && balance != null && Math.abs(assets - balance) > 1) {
    notes.push(`Total assets (${assets}) do not equal liabilities and equity (${balance}) in the filing — treat the balance sheet with care.`);
  }

  if (taxonomy === "ifrs" && figures.find((f) => f.key === "employees")?.current == null) {
    notes.push("No employee count: IFRS/ESEF filings state it in the notes as text, not as a tagged figure.");
  }
  if (taxonomy === "danish-gaap" && figures.find((f) => f.key === "revenue")?.current == null) {
    notes.push("No revenue figure: most small Danish companies (reporting class B) may legally omit revenue and report gross profit instead.");
  }

  return {
    cvr: textFact(facts, NS.gsd, "IdentificationNumberCvrOfReportingEntity") ?? [...contexts.values()][0]?.entity ?? null,
    // ESEF filings name the company in the IFRS taxonomy instead of gsd.
    name:
      textFact(facts, NS.gsd, "NameOfReportingEntity") ??
      (() => {
        const v = facts.find((f) => isIfrsNs(f.ns) && f.name === "NameOfReportingEntityOrOtherMeansOfIdentification")?.value;
        return v ? cleanText(v) || null : null;
      })(),
    reportType: textFact(facts, NS.gsd, "InformationOnTypeOfSubmittedReport"),
    taxonomy,
    scope: !groupReport ? "company" : scope,
    groupReport,
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

export interface ReportFact {
  concept: string;
  taxonomy: string;
  period: string;
  value: number | string;
  unit: string | null;
}

const MAX_TEXT = 500;

function taxonomyLabel(ns: string): string {
  if (ns === NS.fsa) return "fsa";
  if (ns === NS.gsd) return "gsd";
  if (ns === NS.cmn) return "cmn";
  if (ns.includes(NS.ifrsDkMarker)) return "ifrs-dk";
  if (isIfrsNs(ns)) return "ifrs";
  return ns.split(/[/#]/).filter(Boolean).pop() ?? ns;
}

// Every total the filing tags for the chosen entity (group or parent), not only
// the key figures: the full statements as far as the filer tagged them.
// Breakdowns by dimension are left out for the same reason as in extractFinancials.
export function extractFacts(xml: string, scope: Scope = "group"): { groupReport: boolean; facts: ReportFact[] } {
  const { contexts, facts, units } = parseInstance(xml);
  const { groupReport, role } = scopeRole(contexts, scope);
  const out: ReportFact[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const c = contexts.get(f.contextRef);
    if (!c) continue;
    const n = Number(f.value);
    const numeric = f.unitRef != null && Number.isFinite(n);
    // Text about the report itself (name, auditor, opinion) sits in plain
    // contexts even when the group's figures are tagged with a dimension.
    if (c.role !== role && !(!numeric && c.role === "plain")) continue;
    const period = c.instant ?? (c.start && c.end ? `${c.start}..${c.end}` : null);
    if (!period) continue;
    const value = numeric ? n : cleanText(f.value);
    if (value === "") continue;
    const key = `${f.ns}|${f.name}|${period}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      concept: f.name,
      taxonomy: taxonomyLabel(f.ns),
      period,
      value: typeof value === "string" && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value,
      unit: numeric ? (units.get(f.unitRef!) ?? null) : null,
    });
  }
  return { groupReport, facts: out };
}
