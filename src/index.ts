#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchCompanies } from "./cvr.ts";
import { getFinancials, getFinancialsHistory, getReportFacts, listFilings } from "./virk.ts";

const server = new McpServer({ name: "dk-regnskab-mcp", version: "0.3.0" });

// Every result goes out both as structured content (checked against the tool's
// output schema) and as JSON text for clients that only read text.
const ok = <T extends Record<string, unknown>>(value: T) => ({
  structuredContent: value,
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

// All tools only read public data from the Danish Business Authority.
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const cvr = z.string().describe("Danish CVR number, 8 digits (spaces, dashes and a DK prefix are accepted), e.g. \"24256790\".");
const year = z
  .number()
  .int()
  .min(2012)
  .max(2100)
  .optional()
  .describe("Calendar year the reporting period ends in (a 2024/25 financial year ending June 2025 is 2025). Omit for the latest annual report.");
const scope = z
  .enum(["group", "parent"])
  .default("group")
  .describe("For group reports (koncernregnskab): \"group\" = the consolidated group, \"parent\" = the parent company alone. Ignored for single companies.");

const period = z.object({ start: z.string(), end: z.string() }).nullable().describe("Reporting period, ISO dates.");
const source = z
  .object({ publishedAt: z.string().nullable(), documentType: z.string(), url: z.string() })
  .describe("The filing document the figures were read from.");
const resultScope = z.enum(["group", "parent", "company"]).describe("Whose figures these are; \"company\" for a report without a group.");
const notes = z.array(z.string()).describe("Gaps, conflicts and caveats found in the filing, in plain English.");

server.registerTool(
  "search_company",
  {
    title: "Search Danish companies by name",
    description:
      "Find a Danish company's CVR number by name (or check a CVR number) in the CVR register. Use it first when you only have a name; every other tool needs the CVR number. " +
      "Matches all words of the query against current company names; returns name, status, company type, industry and address. " +
      "Needs CVR_USER and CVR_PASSWORD in the server's environment (free system-to-system access to the CVR register); without them it returns an error saying how to get access.",
    inputSchema: {
      query: z.string().min(2).describe("Company name or part of it, e.g. \"Carlsberg\" or \"lego a/s\". An 8-digit CVR number looks up that company."),
      limit: z.number().int().min(1).max(25).default(10).describe("Maximum number of companies to return."),
    },
    outputSchema: {
      companies: z
        .array(
          z.object({
            cvr: z.string(),
            name: z.string().nullable(),
            status: z.string().nullable().describe("Register status, e.g. NORMAL or OPHØRT (dissolved)."),
            companyType: z.string().nullable().describe("Legal form, e.g. APS or A/S."),
            industry: z.string().nullable(),
            address: z.string().nullable(),
          }),
        )
        .describe("Best matches first; empty when nothing matches."),
    },
    annotations: readOnly,
  },
  async ({ query, limit }) => {
    try {
      return ok({ companies: await searchCompanies(query, limit) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_filings",
  {
    title: "List published filings",
    description:
      "List what a Danish company has filed with the Danish Business Authority (Erhvervsstyrelsen): annual reports, interim reports and their documents (PDF, XBRL), newest first. " +
      "Use it to see which years are available or to get document links; use get_financials for the figures themselves. " +
      "Returns an empty list for a CVR number with no filings (e.g. sole proprietorships). No paging: raise limit or set year to reach older filings.",
    inputSchema: {
      cvr,
      limit: z.number().int().min(1).max(50).default(10).describe("How many filings to return, newest first."),
      year: year.describe("Only filings whose reporting period ends in this calendar year. Omit for all years."),
    },
    outputSchema: {
      cvr: z.string(),
      filings: z.array(
        z.object({
          cvr: z.string(),
          type: z.string().nullable().describe("Filing type; \"regnskab\" for financial reports."),
          periodStart: z.string().nullable(),
          periodEnd: z.string().nullable(),
          publishedAt: z.string().nullable(),
          correction: z.boolean().describe("True when this filing corrects (omgørelse) an earlier one."),
          documents: z.array(
            z.object({
              type: z.string().describe("e.g. AARSRAPPORT, AARSRAPPORT_ESEF, HALVAARSRAPPORT."),
              mimeType: z.string(),
              url: z.string(),
            }),
          ),
        }),
      ),
    },
    annotations: readOnly,
  },
  async ({ cvr, limit, year }) => {
    try {
      const filings = await listFilings(cvr, limit, year);
      return ok({ cvr: filings[0]?.cvr ?? cvr, filings });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_financials",
  {
    title: "Get key financials from an annual report",
    description:
      "Read one annual report (XBRL) of a Danish company and return its key figures for that year and the year before: revenue, gross profit, operating profit, profit, equity, assets, cash, employees, plus company name, period, currency and auditor. " +
      "Use it for one year's headline numbers; use get_financials_history for a trend over several years and get_report_facts for any other line item. " +
      "Group reports default to the consolidated group. Values are in the filing's currency (usually DKK); a missing figure is null and notes say why (small companies may legally omit revenue). found=false when the company has no machine-readable annual report for that year.",
    inputSchema: { cvr, year, scope },
    outputSchema: {
      found: z.boolean(),
      message: z.string().optional().describe("Why nothing was found (only when found=false)."),
      cvr: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      reportType: z.string().nullable().optional(),
      taxonomy: z.enum(["danish-gaap", "ifrs", "unknown"]).optional(),
      scope: resultScope.optional(),
      groupReport: z.boolean().optional(),
      period: period.optional(),
      previousPeriod: z.object({ start: z.string().nullable(), end: z.string().nullable() }).nullable().optional(),
      currency: z.string().nullable().optional(),
      auditor: z.object({ firm: z.string().nullable(), assistance: z.string().nullable() }).optional(),
      figures: z
        .array(z.object({ key: z.string(), label: z.string(), current: z.number().nullable(), previous: z.number().nullable() }))
        .optional()
        .describe("Key figures; current = this report's year, previous = the year before."),
      notes: notes.optional(),
      source: source.optional(),
    },
    annotations: readOnly,
  },
  async ({ cvr, year, scope }) => {
    try {
      const result = await getFinancials(cvr, year, scope);
      if (!result) {
        return ok({
          found: false,
          message: year
            ? `No machine-readable annual report ending in ${year} for CVR ${cvr}.`
            : `No machine-readable annual report for CVR ${cvr}. Sole proprietorships and some company types don't file one.`,
        });
      }
      return ok({ found: true, ...result });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_financials_history",
  {
    title: "Get key financials over several years",
    description:
      "Return the same key figures as get_financials for each of a Danish company's latest annual reports, one row per reporting year, newest first. " +
      "Use it for trends and growth; use get_financials when one year (with its previous-year comparison and auditor) is enough. " +
      "Reads one filing per year, so it is slower than get_financials. A corrected report replaces the original; years without a machine-readable report are skipped.",
    inputSchema: {
      cvr,
      years: z.number().int().min(1).max(15).default(5).describe("How many reporting years to return, counting back from the latest."),
      scope,
    },
    outputSchema: {
      name: z.string().nullable(),
      years: z
        .array(
          z.object({
            period,
            currency: z.string().nullable(),
            scope: resultScope,
            figures: z.record(z.string(), z.number().nullable()).describe("Key figure → value for that year (revenue, profit, equity, …); null when not reported."),
            notes,
            source,
          }),
        )
        .describe("Newest first; empty when the company has no machine-readable annual reports."),
    },
    annotations: readOnly,
  },
  async ({ cvr, years, scope }) => {
    try {
      return ok(await getFinancialsHistory(cvr, years, scope));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_report_facts",
  {
    title: "Get all tagged figures from an annual report",
    description:
      "Return every figure and text the company tagged in one annual report (XBRL), not only the key figures: e.g. staff costs, depreciation, receivables, dividends, the auditor's opinion. " +
      "Use it when get_financials doesn't have the line item you need; filter with match to keep the answer short. " +
      "Concepts are the taxonomy's own English names (fsa = Danish GAAP, ifrs = IFRS, gsd/cmn = general details). Breakdowns by dimension are left out; long texts are cut at 500 characters.",
    inputSchema: {
      cvr,
      year,
      scope,
      match: z.string().optional().describe("Only concepts whose name contains this text, case-insensitive, e.g. \"Employee\" or \"Dividend\"."),
      limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of facts to return; total says how many matched."),
    },
    outputSchema: {
      found: z.boolean(),
      message: z.string().optional().describe("Why nothing was found (only when found=false)."),
      name: z.string().nullable().optional(),
      period: period.optional(),
      scope: resultScope.optional(),
      total: z.number().optional().describe("Facts matching the filter, before limit."),
      facts: z
        .array(
          z.object({
            concept: z.string(),
            taxonomy: z.string(),
            period: z.string().describe("An ISO date for balances, \"start..end\" for a period."),
            value: z.union([z.number(), z.string()]),
            unit: z.string().nullable().describe("Currency or unit for numbers, e.g. DKK; null for text."),
          }),
        )
        .optional(),
      source: source.optional(),
    },
    annotations: readOnly,
  },
  async ({ cvr, year, scope, match, limit }) => {
    try {
      const result = await getReportFacts(cvr, year, scope, match, limit);
      if (!result) {
        return ok({
          found: false,
          message: year
            ? `No machine-readable annual report ending in ${year} for CVR ${cvr}.`
            : `No machine-readable annual report for CVR ${cvr}.`,
        });
      }
      const f = result.financials;
      return ok({ found: true, name: f.name, period: f.period, scope: f.scope, total: result.total, facts: result.facts, source: f.source });
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
