/**
 * lib/leads/regions.ts — which country a lead's province or state code is in.
 *
 * Moved out of lib/web-leads/filters.ts when the Prospects surface was retired
 * (2026-10-28); the lead create form (lib/oasis-lead-create.ts) still needs it.
 * The split is a legal line, not a label: CASL governs the Canadian leads and
 * US rules the rest.
 */

/**
 * Canada is spelled by its province codes; anything else on a lead is the US.
 * Derived rather than stored so a lead that already exists does not need a
 * backfill to appear in the right place, and a typo cannot invent a country.
 */
export const CA_REGIONS: readonly string[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
];

export type LeadCountry = "ca" | "us";

/** @param region the lead's province/state code */
export function countryOf(region: string | null | undefined): LeadCountry {
  return CA_REGIONS.includes(String(region || "").trim().toUpperCase()) ? "ca" : "us";
}
