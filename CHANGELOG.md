# Changelog

## 0.2.0 — unreleased

- `get_financials` gets `scope`: consolidated group (default) or parent company for group reports, in both Danish GAAP and IFRS. Before, a group report could return a mix.
- Balance check: a note when total assets don't equal liabilities and equity.
- IFRS before ESEF: revenue from the Danish IFRS extension (`NetSales`) and support for the 2011 IFRS taxonomy (filings before 2016).
- Currency is taken from the key figures' own units, so USD filers like Maersk get a currency.
- `year` is filtered in the filing index, so older reports from companies with many filings are found. Interim reports carrying an annual-report document are no longer mistaken for annual reports.
- Company name, report type and auditor are filled from sibling documents in the same filing; HTML markup in text facts is stripped.
- IFRS results explain the missing employee count.
- `npm run measure`: live check against real filings.

## 0.1.0 — unreleased

- `get_financials`: key figures (current and previous year), period, currency and auditor from a company's latest or chosen annual report.
- `list_filings`: a company's published filings with document links.
- Danish GAAP and IFRS/ESEF taxonomies.
- Ignores dimensional facts, flags conflicting values, explains legally omitted revenue.
