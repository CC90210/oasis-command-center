/**
 * lib/web-leads/enrichment.ts — how much do we actually know before the dial?
 *
 * A rep's queue is long and their day is not. The board already sorts by
 * OPPORTUNITY (whose website is worst), which answers "who needs us most" and
 * says nothing about whether the call can succeed. This answers the other half:
 * of the prospects worth calling, which ones do we know enough about to reach a
 * decision-maker instead of a receptionist.
 *
 * THE TIER IS EVIDENCE, NOT A SCORE. Every level below is a statement about
 * what somebody verified, traceable to a record: a name read off the company's
 * own About page, a number a federal registry publishes, a verification state
 * written by a reconciler that refuses to guess. Nothing here is inferred from
 * the absence of data, and nothing is averaged — a lead cannot climb a tier by
 * accumulating weak signals.
 *
 * WHY `conflict` IS NOT THE BOTTOM TIER: it is not a tier at all. A contradicted
 * lead is quarantined off the board upstream (promote-osm.mjs), so a rep never
 * sees one. If one ever appears here it is a bug, and it is ranked as `thin` so
 * it sinks rather than being handed to somebody as workable.
 */

/** Ordered worst to best. The array order IS the ranking. */
export const ENRICHMENT_TIERS = ["thin", "contactable", "named", "verified"] as const;
export type EnrichmentTier = (typeof ENRICHMENT_TIERS)[number];

/** What the rep sees. Plain business language, no jargon, no em dashes. */
export const ENRICHMENT_LABELS: Record<EnrichmentTier, string> = {
  verified: "Verified owner",
  named: "Owner named",
  contactable: "Phone only",
  thin: "Needs research",
};

export const ENRICHMENT_BLURBS: Record<EnrichmentTier, string> = {
  verified:
    "We know the owner by name and an independent source publishes this number for them. Ask for them by name.",
  named:
    "We know the owner by name, but nothing outside the lead itself confirms the number. Ask for them by name and expect a gatekeeper.",
  contactable:
    "We have a number and no name. You will be asking whoever answers who makes the decisions.",
  thin: "Not enough to call on yet. Leave these for the enrichment pass.",
};

/** The minimum a lead needs before a rep can dial at all. */
function hasPhone(l: { phone?: string | null; ownerPhone?: string | null }): boolean {
  return Boolean((l.ownerPhone && l.ownerPhone.trim()) || (l.phone && l.phone.trim()));
}

/**
 * Which tier is this lead in?
 *
 * @param l the lead, duck-typed so this stays usable from the card, the filter
 *   and a test without importing the full WebLead type in either direction.
 */
export function enrichmentTier(l: {
  ownerName?: string | null;
  ownerPhone?: string | null;
  phone?: string | null;
  ownerVerification?: string | null;
}): EnrichmentTier {
  const named = Boolean(l.ownerName && l.ownerName.trim());
  const reachable = hasPhone(l);
  const state = (l.ownerVerification || "").trim();

  // A contradicted lead is never workable, whatever else we hold about it.
  if (state === "conflict") return "thin";

  // `verified` requires BOTH halves. A confirmed state with nobody to ask for
  // is a corroborated main line, which is `contactable` with extra steps, and a
  // name with no number cannot be called at all.
  if (state === "confirmed" && named && reachable) return "verified";
  if (named && reachable) return "named";
  if (reachable) return "contactable";
  return "thin";
}

/** Rank for sorting. Higher is more enriched. */
export function enrichmentRank(l: Parameters<typeof enrichmentTier>[0]): number {
  return ENRICHMENT_TIERS.indexOf(enrichmentTier(l));
}

/**
 * The filter's value. "all" is the default because a rep landing on an
 * empty-looking queue assumes the board is broken, and the verified share of
 * the board is small on the US side.
 */
export type EnrichmentFilter = "all" | EnrichmentTier;

const VALID: readonly string[] = ["all", ...ENRICHMENT_TIERS];
export function parseEnrichment(raw: string | null | undefined): EnrichmentFilter {
  return VALID.includes(raw || "") ? (raw as EnrichmentFilter) : "all";
}

/**
 * Does this lead pass the filter?
 *
 * Choosing a tier means "this tier AND better", not "exactly this tier". A rep
 * asking for named owners wants the verified ones too; making them switch
 * filters to see the best leads is a trap, and one that silently hides the
 * strongest prospects behind a narrower-looking choice.
 */
export function passesEnrichment(
  l: Parameters<typeof enrichmentTier>[0],
  f: EnrichmentFilter,
): boolean {
  if (f === "all") return true;
  return enrichmentRank(l) >= ENRICHMENT_TIERS.indexOf(f);
}
