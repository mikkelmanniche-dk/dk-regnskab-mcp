#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getFinancials, listFilings } from "./virk.ts";

const server = new McpServer({ name: "dk-regnskab-mcp", version: "0.2.0" });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

const cvr = z.string().describe("Danish CVR number, 8 digits (spaces, dashes and a DK prefix are accepted).");

server.registerTool(
  "list_filings",
  {
    title: "List published filings",
    description:
      "List what a Danish company has published with the Danish Business Authority (Erhvervsstyrelsen): annual reports, half-year reports and their documents, newest first.",
    inputSchema: {
      cvr,
      limit: z.number().int().min(1).max(50).default(10).describe("How many filings to return."),
    },
  },
  async ({ cvr, limit }) => {
    try {
      return json(await listFilings(cvr, limit));
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
      "Read a Danish company's published annual report (XBRL) and return key figures for the reporting year and the year before: revenue, gross profit, profit, equity, assets, cash, employees, plus auditor. For group reports it returns the consolidated group by default. " +
      "Values are in the filing's currency (usually DKK). Small companies often omit revenue legally; notes explain gaps and conflicts instead of guessing.",
    inputSchema: {
      cvr,
      year: z
        .number()
        .int()
        .min(2012)
        .max(2100)
        .optional()
        .describe("Calendar year the reporting period ends in. Omit for the latest annual report."),
      scope: z
        .enum(["group", "parent"])
        .default("group")
        .describe("For group reports (koncernregnskab): the consolidated group, or the parent company alone. Ignored for single companies."),
    },
  },
  async ({ cvr, year, scope }) => {
    try {
      const result = await getFinancials(cvr, year, scope);
      if (!result) {
        return json({
          found: false,
          message: year
            ? `No machine-readable annual report ending in ${year} for CVR ${cvr}.`
            : `No machine-readable annual report for CVR ${cvr}. Sole proprietorships and some company types don't file one.`,
        });
      }
      return json({ found: true, ...result });
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
