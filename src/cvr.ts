import { get } from "./virk.ts";

// The CVR register itself (names, addresses, status). Unlike the filing index it
// requires credentials for system-to-system access; they are free but must be
// applied for at the Danish Business Authority. Like the filing index it only
// answers over plain HTTP (HTTPS timed out on 2026-09-25), so the credentials
// travel unencrypted; they only grant read access to public data.
const CVR_URL = "http://distribution.virk.dk/cvr-permanent/virksomhed/_search";
export const CVR_SIGNUP = "https://datacvr.virk.dk/artikel/system-til-system-adgang-til-cvr-data";

export interface Company {
  cvr: string;
  name: string | null;
  status: string | null;
  companyType: string | null;
  industry: string | null;
  address: string | null;
}

export class MissingCredentialsError extends Error {}

const M = "Vrvirksomhed.virksomhedMetadata";

function formatAddress(a: any): string | null {
  if (!a) return null;
  const street = [a.vejnavn, a.husnummerFra, a.bogstavFra].filter(Boolean).join(" ");
  const city = [a.postnummer, a.postdistrikt].filter(Boolean).join(" ");
  return [a.conavn ? `c/o ${a.conavn}` : null, street, city].filter(Boolean).join(", ") || null;
}

export async function searchCompanies(query: string, limit = 10): Promise<Company[]> {
  const user = process.env.CVR_USER;
  const password = process.env.CVR_PASSWORD;
  if (!user || !password) {
    throw new MissingCredentialsError(
      `Company search needs access to the CVR register: set CVR_USER and CVR_PASSWORD in the server's environment (free, apply at ${CVR_SIGNUP}). ` +
        "If you already know the CVR number, call get_financials or list_filings directly.",
    );
  }
  const q = query.trim();
  const digits = q.replace(/\s|-/g, "").replace(/^DK/i, "");
  const body = {
    _source: [
      "Vrvirksomhed.cvrNummer",
      `${M}.nyesteNavn.navn`,
      `${M}.sammensatStatus`,
      `${M}.nyesteVirksomhedsform.kortBeskrivelse`,
      `${M}.nyesteHovedbranche.branchetekst`,
      `${M}.nyesteBeliggenhedsadresse`,
    ],
    query: /^\d{8}$/.test(digits)
      ? { term: { "Vrvirksomhed.cvrNummer": Number(digits) } }
      : { match: { [`${M}.nyesteNavn.navn`]: { query: q, operator: "and" } } },
    size: limit,
  };
  const res = await get(CVR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return (json?.hits?.hits ?? []).map((h: any): Company => {
    const v = h._source?.Vrvirksomhed ?? {};
    const m = v.virksomhedMetadata ?? {};
    return {
      cvr: String(v.cvrNummer ?? "").padStart(8, "0"),
      name: m.nyesteNavn?.navn ?? null,
      status: m.sammensatStatus ?? null,
      companyType: m.nyesteVirksomhedsform?.kortBeskrivelse ?? null,
      industry: m.nyesteHovedbranche?.branchetekst ?? null,
      address: formatAddress(m.nyesteBeliggenhedsadresse),
    };
  });
}
