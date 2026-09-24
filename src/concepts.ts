// Key figures we extract, mapped to the concept names used in the two
// taxonomies Danish filings arrive in: Danish GAAP ("fsa") and IFRS/ESEF.
// Order matters: the first concept that has a value wins.

export type Period = "duration" | "instant";

export interface KeyFigure {
  key: string;
  label: string;
  period: Period;
  fsa: string[];
  ifrs: string[];
  // Danish IFRS extension used before ESEF (until 2020), e.g. NetSales.
  ifrsDk?: string[];
}

export const KEY_FIGURES: KeyFigure[] = [
  { key: "revenue", label: "Nettoomsætning / Revenue", period: "duration", fsa: ["Revenue"], ifrs: ["Revenue", "RevenueFromContractsWithCustomers"], ifrsDk: ["NetSales"] },
  { key: "grossProfit", label: "Bruttofortjeneste / Gross profit", period: "duration", fsa: ["GrossProfitLoss", "GrossResult"], ifrs: ["GrossProfit"] },
  { key: "operatingProfit", label: "Resultat af primær drift / Operating profit", period: "duration", fsa: ["ProfitLossFromOrdinaryOperatingActivities"], ifrs: ["ProfitLossFromOperatingActivities"] },
  { key: "profitBeforeTax", label: "Resultat før skat / Profit before tax", period: "duration", fsa: ["ProfitLossFromOrdinaryActivitiesBeforeTax"], ifrs: ["ProfitLossBeforeTax"] },
  { key: "profit", label: "Årets resultat / Profit for the year", period: "duration", fsa: ["ProfitLoss"], ifrs: ["ProfitLoss"] },
  { key: "employees", label: "Gns. antal ansatte / Average employees", period: "duration", fsa: ["AverageNumberOfEmployees"], ifrs: [] },
  { key: "assets", label: "Aktiver i alt / Total assets", period: "instant", fsa: ["Assets"], ifrs: ["Assets"] },
  { key: "currentAssets", label: "Omsætningsaktiver / Current assets", period: "instant", fsa: ["CurrentAssets"], ifrs: ["CurrentAssets"] },
  { key: "cash", label: "Likvide beholdninger / Cash", period: "instant", fsa: ["CashAndCashEquivalents"], ifrs: ["CashAndCashEquivalents"] },
  { key: "equity", label: "Egenkapital / Equity", period: "instant", fsa: ["Equity"], ifrs: ["Equity"] },
  { key: "liabilities", label: "Gældsforpligtelser / Liabilities", period: "instant", fsa: ["LiabilitiesOtherThanProvisions"], ifrs: ["Liabilities"] },
];

export const NS = {
  fsa: "http://xbrl.dcca.dk/fsa",
  gsd: "http://xbrl.dcca.dk/gsd",
  cmn: "http://xbrl.dcca.dk/cmn",
  xbrli: "http://www.xbrl.org/2003/instance",
  // ESEF filings use a dated IFRS namespace, e.g. https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full
  ifrsSuffix: "/ifrs-full",
  // Filings before 2016 use the 2011 taxonomy: http://xbrl.ifrs.org/taxonomy/2011-03-25/ifrs
  ifrsLegacy: /^https?:\/\/xbrl\.ifrs\.org\/taxonomy\/[^/]+\/ifrs$/,
  // e.g. http://xbrl.dcca.dk/ifrs-dk-cor_2019-12-20
  ifrsDkMarker: "/ifrs-dk-cor",
} as const;
