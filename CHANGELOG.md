# Changelog

## 0.3.1 — 2026-09-25

- Published to npm (`npx -y dk-regnskab-mcp`) and listed in the official MCP Registry as `io.github.mikkelmanniche-dk/dk-regnskab-mcp` (`server.json`).
- README: `npx` setup for Claude Code, Claude Desktop and Cursor.
- `package.json`: repository, homepage and `mcpName`; tests and build run before every publish.

## 0.3.0 — 2026-09-25

- `search_company`: find a CVR number by company name in the CVR register. Needs free system-to-system credentials (`CVR_USER`, `CVR_PASSWORD`); without them the tool explains how to get access.
- `get_financials_history`: key figures for up to 15 reporting years in one call, one row per year, corrections replacing originals.
- `get_report_facts`: every figure and text tagged in an annual report, filterable by concept name, for line items beyond the key figures.
- `list_filings` gets `year`.
- All tools declare output schemas and return structured content, and are annotated as read-only. Descriptions say when to use which tool and what comes back when nothing is found.
- Fix: an annual report that also tags its last quarter (Maersk 2020) returned the quarter instead of the full year.

## 0.2.0 — 2026-09-24

- `get_financials` gets `scope`: consolidated group (default) or parent company for group reports, in both Danish GAAP and IFRS. Before, a group report could return a mix.
- Balance check: a note when total assets don't equal liabilities and equity.
- IFRS before ESEF: revenue from the Danish IFRS extension (`NetSales`) and support for the 2011 IFRS taxonomy (filings before 2016).
- Currency is taken from the key figures' own units, so USD filers like Maersk get a currency.
- `year` is filtered in the filing index, so older reports from companies with many filings are found. Interim reports carrying an annual-report document are no longer mistaken for annual reports.
- Company name, report type and auditor are filled from sibling documents in the same filing; HTML markup in text facts is stripped.
- IFRS results explain the missing employee count.
- `npm run measure`: live check against real filings.

## 0.1.0 — 2026-09-23

- `get_financials`: key figures (current and previous year), period, currency and auditor from a company's latest or chosen annual report.
- `list_filings`: a company's published filings with document links.
- Danish GAAP and IFRS/ESEF taxonomies.
- Ignores dimensional facts, flags conflicting values, explains legally omitted revenue.
