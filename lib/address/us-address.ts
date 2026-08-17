/**
 * US ADDRESS — the single implementation of "is this address complete, and how
 * do I print the most complete version of it".
 *
 * WHY
 * The merchant application collects ONE free-text line per address and no city
 * or ZIP input at all. Ezra, 2026-08-13:
 *
 *   "on app needs full addresses"
 *
 * and Adon, relaying the actual failure:
 *
 *   "In the actual PDF, to include the address, it doesn't make them have to
 *    put in the city, state, and ZIP Code. Some people literally just put their
 *    street name and I'm like, 'Where the fuck do you live bro?'"
 *
 * Measured on production at the time of writing: of 1,051 application records
 * carrying a business address, 514 had no ZIP, and 391 of those had no state
 * either — bare street lines like "7930 Snow View Drive" going out to lenders.
 *
 * Before this module the completeness logic lived as a private `composeAddress`
 * inside lib/forms/application-pdf.ts with EXACTLY ONE call site, on the legacy
 * fallback mapper. The live form-driven mapper never called it, so the shipped
 * PDF never merged the state, while the test suite asserted against the dead
 * path and stayed green. One implementation, used by every address, is the
 * point of this file.
 *
 * FAITHFUL, NOT CLEVER
 * `splitUsAddress` only fills a part it can actually identify. A street-only
 * string returns line1 alone — it never invents a city, state or ZIP. Callers
 * pass dedicated columns first and use the parse only to fill gaps. An address
 * we cannot complete must surface as incomplete, never be quietly guessed.
 *
 * WHAT THIS IS NOT
 * Not a validator of whether an address physically exists, and not a geocoder.
 * It answers "does this string carry a street, city, state and ZIP" — nothing
 * about deliverability.
 *
 * KNOWN LIMITATION — a city NAMED after a state parses as that state, so
 * mergeStateIntoAddress leaves it alone and the separately-stored state is not
 * added. "PO BOX 94, WYOMING 14591" is Wyoming, NEW YORK, and reads as WY.
 * Measured on production: 19 of 593 addresses parse a state that differs from
 * the stored dropdown, and all but roughly one of those are cases where the
 * DROPDOWN is the wrong one ("Newington, Connecticut" stored as NY, "Mebane,
 * North Carolina" stored as AR). Trusting the address is therefore right far
 * more often than not, and a heuristic to catch the remainder would risk the
 * 284 records the spelled-out-state fix repaired. Left as a known edge rather
 * than papered over. (Codex P2, 2026-08-14.)
 *
 * ADDING A RULE
 *   1. Extend the pure functions here, never in a renderer or a route.
 *   2. `tests/us-address.test.ts` is the contract; add the case there first.
 *
 * Provenance: ported from lib/address/split-us-address.ts on the unmerged
 * branch apex/bd-home-address (PR #76, Codex-reviewed, including its fix for a
 * dropped apartment number). That branch is 327 commits behind main and does
 * not merge; the file is carried over rather than the branch.
 *
 * Pure, no dependencies — importable from tests without any server-only chain.
 */

export type SplitAddress = { line1: string; city: string; state: string; zip: string };

/** Which parts a complete US address needs. `line1` is required implicitly. */
export type AddressPart = "city" | "state" | "zip";

export type AddressCompleteness = {
  complete: boolean;
  /** Parts we could not find. Empty when `complete` is true. */
  missing: AddressPart[];
  parts: SplitAddress;
};

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


/** State names longest-first, so "west virginia" is tested before "virginia". */
const STATE_NAMES_LONGEST_FIRST = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length);

function trimSep(s: string): string {
  return s.replace(/[,\s]+$/, "").replace(/^[,\s]+/, "").trim();
}

/** Parse a whole US address string into structured parts. Never invents a part. */
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
    // LONGEST NAME FIRST. "virginia" also matches the tail of "West Virginia"
    // (the preceding space satisfies the `[,\s]` boundary), so plain insertion
    // order resolved "Davis Street, Lewisburg, West Virginia, 24901" to VA and
    // left the orphaned word "West" in the street line. Real production record.
    for (const name of STATE_NAMES_LONGEST_FIRST) {
      const re = new RegExp(`(?:^|[,\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
      if (re.test(s)) {
        out.state = STATE_NAMES[name];
        s = trimSep(s.replace(re, ""));
        break;
      }
    }
  }

  // remaining: "line1, city" | "line1" | "city". Only trust a comma as the
  // street/city boundary when a state or zip anchored this as a real full
  // address. Without that anchor a comma is more likely a unit suffix
  // ("123 Main St, Apt 4") — keep it whole in line1 so nothing is dropped.
  const hasAnchor = Boolean(out.state || out.zip);
  if (s.includes(",") && hasAnchor) {
    const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      out.city = parts[parts.length - 1];
      out.line1 = parts.slice(0, -1).join(", ");
    } else if (parts.length === 1) {
      out.line1 = parts[0];
    }
  } else if (s) {
    // No comma boundary to use. If the token starts with a house number it's a
    // street → line1; otherwise, only when a state/zip anchored the string,
    // treat the leftover as the city (e.g. "Miami FL 33101").
    const startsWithNumber = /^\d/.test(s);
    if (startsWithNumber || !hasAnchor) {
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

/** True when the token is a real 2-letter USPS code. */
export function isStateCode(s: string | null | undefined): boolean {
  const v = (s || "").trim().toUpperCase();
  return v.length === 2 && STATE_CODES.has(v);
}

/**
 * Merge a separately-held state back into a one-line address.
 *
 * BEHAVIOUR IS DELIBERATELY BYTE-FOR-BYTE what the private `composeAddress` in
 * application-pdf.ts did, because `tests/application-pdf.test.ts` pins its exact
 * output ("123 Biscayne Blvd, Miami, FL 33101" / "…, Miami, FL"). Splitting and
 * recomposing instead would normalise punctuation differently and silently
 * change every business address on every PDF. Idempotent: an address already
 * carrying the state is returned untouched.
 *
 * The autocomplete field usually stores "street, city, ZIP" with NO state — the
 * state lives in the separate `business_state` dropdown used for lender
 * matching — which is why this merge exists at all.
 */
export function mergeStateIntoAddress(addr: unknown, state: unknown): string {
  const a = typeof addr === "string" ? addr.trim() : addr == null ? "" : String(addr).trim();
  const st = (typeof state === "string" ? state : state == null ? "" : String(state)).trim().toUpperCase();
  if (!a) return "";
  if (!/^[A-Z]{2}$/.test(st)) return a; // no usable 2-letter state → leave as-is
  // If the address already carries a state OF ITS OWN, leave it completely
  // alone — whether written as "FL" or spelled out "Florida", and even when it
  // DISAGREES with the separately-stored one.
  //
  // Measured on production, both failure modes were real. Matching only the
  // 2-letter code appended a duplicate to 284 stored addresses ("…, Naples,
  // Florida, FL 34104", "…, New York, New York, NY 10175"). And 28 records have
  // a dropdown state that contradicts the address outright — "East 1175th
  // Avenue, Crawford, Illinois, 62449" stored with business_state = "CA" —
  // where appending produced the nonsense "Illinois, CA 62449". The address the
  // merchant actually typed is the better evidence of where they are, so it
  // wins; the dropdown only ever FILLS a gap, never overrides.
  //
  // Delegating to splitUsAddress instead of hand-rolling more regexes also
  // means the state-position rules live in exactly one place. The original
  // composeAddress had both bugs; they were invisible because it only ever ran
  // on the dead legacy mapper.
  if (splitUsAddress(a).state) return a;
  // Insert before a trailing ZIP: "..., Miami, 33101" -> "..., Miami, FL 33101".
  const zip = a.match(/^(.*?)[,\s]*(\d{5}(?:-\d{4})?)\s*$/);
  if (zip) return `${zip[1].replace(/[,\s]+$/, "")}, ${st} ${zip[2]}`;
  // No ZIP — append the state.
  return `${a.replace(/[,\s]+$/, "")}, ${st}`;
}

/**
 * The ONE rule every address on the application goes through.
 *
 * Prints the most complete line we can honestly assemble: merges a separately
 * held state when one exists, otherwise returns the address unchanged. It never
 * fabricates a missing city or ZIP — use `addressCompleteness` to find out what
 * is still absent and tell a human, rather than inventing it.
 */
export function composeCompleteAddress(addr: unknown, fallbackState?: unknown): string {
  return mergeStateIntoAddress(addr, fallbackState ?? "");
}

/**
 * Does this address carry a street, city, state and ZIP?
 *
 * `fallbackState` covers the business address, whose state is held in its own
 * dropdown rather than inside the line. There is no equivalent field for owner
 * or partner home addresses, so those are judged on the string alone.
 */
export function addressCompleteness(
  addr: unknown,
  fallbackState?: unknown,
): AddressCompleteness {
  // Judge the line we will actually PRINT, not the raw input. Merging the
  // separately-held state in first also gives the splitter an anchor, which is
  // what lets it treat a comma as a real street/city boundary: without a state
  // or ZIP it deliberately refuses to guess, so "123 Biscayne Blvd, Miami"
  // parses as one street line (the comma could equally be "…, Apt 4"). Compose
  // first and the same string resolves correctly as street + city.
  const composed = composeCompleteAddress(addr, fallbackState);
  const resolved = splitUsAddress(composed);

  const missing: AddressPart[] = [];
  if (!resolved.city) missing.push("city");
  if (!resolved.state) missing.push("state");
  if (!resolved.zip) missing.push("zip");

  // An address with no street line at all is incomplete no matter what else is
  // present; report the street as missing via `line1` being empty, and treat
  // the whole thing as not complete.
  const hasStreet = Boolean(resolved.line1);
  return { complete: hasStreet && missing.length === 0, missing, parts: resolved };
}

/**
 * The CAPTURE gate — may this address be accepted from a merchant?
 *
 * Deliberately weaker than `addressCompleteness`, and the difference is the
 * whole point. Completeness also wants a city, but the city is the ONE part
 * that cannot be parsed reliably: without a comma to mark the boundary,
 * "123 Main Street Miami Florida 33101" resolves its state and ZIP correctly
 * and still yields no city, because "Miami" is indistinguishable from more
 * street. Gating on that would reject a perfectly good address and kill a live
 * funding application — the worst possible failure for this feature.
 *
 * So the gate requires a street, a state and a ZIP: all three parse reliably in
 * every real format tested (comma-separated, comma-free, PO Box, rural route).
 * A bare "7930 Snow View Drive" has none of them and is refused, which is the
 * case this exists to stop. The city is surfaced to the operator as an advisory
 * instead of blocking the merchant.
 *
 * `fallbackState` lets the business address satisfy the state requirement from
 * its separate dropdown.
 */
export function isAcceptableCaptureAddress(
  addr: unknown,
  fallbackState?: unknown,
): { ok: boolean; message: string } {
  const raw = (typeof addr === "string" ? addr : addr == null ? "" : String(addr)).trim();
  if (!raw) return { ok: false, message: "Enter the full address." };

  const { parts } = addressCompleteness(raw, fallbackState);
  const needs: string[] = [];
  if (!parts.line1) needs.push("street address");
  if (!parts.state) needs.push("state");
  if (!parts.zip) needs.push("ZIP code");

  if (!needs.length) return { ok: true, message: "" };
  const last = needs.pop();
  const list = needs.length ? `${needs.join(", ")} and ${last}` : last;
  return {
    ok: false,
    message: `Include the ${list}. For example: 911 Magnolia Dr, Algonquin, IL 60102`,
  };
}

/** Human sentence naming what an address is missing. "" when complete. */
export function describeMissingAddressParts(missing: AddressPart[]): string {
  if (!missing.length) return "";
  const label: Record<AddressPart, string> = { city: "city", state: "state", zip: "ZIP code" };
  const names = missing.map((m) => label[m]);
  if (names.length === 1) return `Add the ${names[0]}.`;
  const last = names.pop();
  return `Add the ${names.join(", ")} and ${last}.`;
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
