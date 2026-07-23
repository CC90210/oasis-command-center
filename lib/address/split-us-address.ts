/**
 * split-us-address — parse a whole US address string into structured parts so
 * the split `owner_address_line1/city/state/zip` namespace the Lead drawer reads
 * (components/leads/LeadFileBody.tsx) can be populated from a single free-text
 * address (CSV import, or the whole `owner_home_address` a form / PDF captures).
 *
 * Faithful, not clever: it only fills a part when it can identify it. A
 * street-only string ("123 Main St") returns just line1 — it never invents a
 * city/state/zip. Callers pass any dedicated city/state/zip columns first and
 * use this only to fill the gaps.
 *
 * Pure, no deps. Handles the dominant real formats:
 *   "123 Main St, Miami, FL 33101"
 *   "123 Main St, Miami FL 33101"
 *   "123 Main St Apt 4, Brooklyn, New York 11201"
 *   "123 Main St"      → line1 only
 *   "Miami, FL 33101"  → city/state/zip, no line1
 */

export type SplitAddress = { line1: string; city: string; state: string; zip: string };

const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR",
  "VI", "GU", "AS", "MP",
]);

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
};

function trimSep(s: string): string {
  return s.replace(/[,\s]+$/, "").replace(/^[,\s]+/, "").trim();
}

export function splitUsAddress(raw: string | null | undefined): SplitAddress {
  const out: SplitAddress = { line1: "", city: "", state: "", zip: "" };
  let s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return out;

  // strip a trailing country token
  s = trimSep(s.replace(/,?\s*(united states of america|united states|u\.?s\.?a\.?|u\.?s\.?)\s*$/i, ""));

  // trailing ZIP (5 or ZIP+4) — keep the 5-digit base
  const zipM = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zipM) {
    out.zip = zipM[1];
    s = trimSep(s.slice(0, zipM.index));
  }

  // trailing state — 2-letter code, else full name
  const codeM = s.match(/(?:^|[,\s])([A-Za-z]{2})\s*$/);
  if (codeM && STATE_CODES.has(codeM[1].toUpperCase())) {
    out.state = codeM[1].toUpperCase();
    s = trimSep(s.replace(/(?:^|[,\s])[A-Za-z]{2}\s*$/, ""));
  } else {
    for (const name of Object.keys(STATE_NAMES)) {
      const re = new RegExp(`(?:^|[,\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
      if (re.test(s)) {
        out.state = STATE_NAMES[name];
        s = trimSep(s.replace(re, ""));
        break;
      }
    }
  }

  // remaining: "line1, city" | "line1" | "city"
  if (s.includes(",")) {
    const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      out.city = parts[parts.length - 1];
      out.line1 = parts.slice(0, -1).join(", ");
    } else if (parts.length === 1) {
      out.line1 = parts[0];
    }
  } else if (s) {
    // No comma to separate street from city. If the token starts with a house
    // number it's a street → line1; otherwise, only if we already found a
    // state or zip, treat the leftover as the city (e.g. "Miami FL 33101").
    const startsWithNumber = /^\d/.test(s);
    if (startsWithNumber || (!out.state && !out.zip)) {
      out.line1 = s;
    } else {
      out.city = s;
    }
  }

  return out;
}

/** Recompose a canonical whole address from parts (skips empties). */
export function composeUsAddress(a: SplitAddress): string {
  const cityStateZip = [a.city, [a.state, a.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [a.line1, cityStateZip].filter(Boolean).join(", ");
}

/** Normalize a state token to a 2-letter USPS code when recognizable. */
export function normalizeState(s: string | null | undefined): string {
  const v = (s || "").trim();
  if (!v) return "";
  if (v.length === 2 && STATE_CODES.has(v.toUpperCase())) return v.toUpperCase();
  return STATE_NAMES[v.toLowerCase()] || v;
}

export type HomeAddressInput = {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

/**
 * Reconcile an owner/home address supplied as any mix of a whole string plus
 * dedicated city/state/zip columns into BOTH namespaces the app uses:
 *   - split `owner_address_line1/city/state/zip` (the Lead drawer reads these)
 *   - whole `owner_home_address` (PDFs, background-check snapshot, TPS enrichment)
 * Dedicated columns win; the parsed whole-string only fills the gaps. Returns a
 * `data` object of exactly the keys that are non-empty, ready to spread into a
 * tenant_records.data write.
 */
export function resolveHomeAddress(input: HomeAddressInput): {
  parts: SplitAddress;
  whole: string;
  data: Record<string, string>;
} {
  const parsed = splitUsAddress(input.address);
  const parts: SplitAddress = {
    line1: parsed.line1 || (input.address || "").trim(),
    city: (input.city || "").trim() || parsed.city,
    state: normalizeState(input.state) || parsed.state,
    zip: (input.zip || "").trim() || parsed.zip,
  };
  const whole = composeUsAddress(parts);
  const data: Record<string, string> = {};
  if (parts.line1) data.owner_address_line1 = parts.line1;
  if (parts.city) data.owner_address_city = parts.city;
  if (parts.state) data.owner_address_state = parts.state;
  if (parts.zip) data.owner_address_zip = parts.zip;
  if (whole) data.owner_home_address = whole;
  return { parts, whole, data };
}
