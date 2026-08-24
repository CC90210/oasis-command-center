/**
 * One definition of what a website-sales lead is made of, and one rule for
 * when it belongs to the OASIS board.
 *
 * WHY THIS EXISTS. Six different code paths write leads into tenant_records
 * — the manifest form, /api/leads/import, the chat importer, the import
 * wizard, cold-list promotion, and public form intake — and each had grown
 * its own field mapping. Only one of them (lib/leads-import-service.ts)
 * carried the website research and stamped sales_program. The board query
 * for the website-sales tenant filters on exactly that stamp, so leads that
 * arrived through any other door were invisible at the database level: the
 * row existed, the website was in it, and no screen would ever show it.
 * "Transferring leads doesn't work" is that filter, seen from the outside.
 *
 * Import a field set or a stamping rule from here rather than restating it.
 * A seventh writer that forgets the stamp is the same outage again.
 */

import { OASIS_LEAD_STAGE_KEYS } from "@/lib/oasis-stage-meta";
import { OASIS_WEBSITE_SALES_PROGRAM } from "@/lib/oasis-sales-pipeline-policy";

// Re-exported, not redeclared. This module tells other writers not to restate
// its rules; declaring a second copy of the program string here would have
// been the same mistake in miniature — two spellings of the marker the board
// filters on, free to drift apart.
export { OASIS_WEBSITE_SALES_PROGRAM };

/**
 * The research fields that make a lead a website-sales lead. Presence of ANY
 * of these is what marks a row as belonging to that program — a scraped lead
 * with only a URL is still a website-sales lead, and gets the stamp.
 */
export const WEBSITE_SALES_KEYS = [
  "website",
  "website_condition",
  "audit_findings",
  "icp_track",
] as const;

/** Context fields a rep wants on the call. Not program markers on their own. */
export const LEAD_CONTEXT_KEYS = ["industry", "business_city", "state"] as const;

/** Every website/context key, for importers deciding what to carry across. */
export const WEBSITE_SALES_FIELD_KEYS = [...WEBSITE_SALES_KEYS, ...LEAD_CONTEXT_KEYS] as const;

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

/** True when this lead carries website-sales research. */
export function isWebsiteSalesLead(data: Record<string, unknown>): boolean {
  return WEBSITE_SALES_KEYS.some((k) => hasValue(data[k]));
}

/**
 * The sales_program stamp for a lead, or {} when it isn't one.
 *
 * Spread into the data object at write time:
 *   data: { ...fields, ...stampSalesProgram(fields) }
 *
 * Never overwrites a program already set — an explicitly-classified lead
 * outranks our inference from its fields.
 */
export function stampSalesProgram(data: Record<string, unknown>): Record<string, string> {
  if (hasValue(data.sales_program)) return {};
  return isWebsiteSalesLead(data) ? { sales_program: OASIS_WEBSITE_SALES_PROGRAM } : {};
}

/**
 * Tenants whose leads belong to the website-sales program.
 *
 * WHY A TENANT CHECK GUARDS THE STAMP. Field presence alone is not enough on
 * the routes SunBiz and OASIS share. "This merchant has a website" is ordinary,
 * unremarkable information on a funding application — so inferring the program
 * from a `website` column would take a SunBiz MCA lead imported at `uw_sheet`,
 * reclassify it as website-sales, and move it to `researched`, walking it out
 * of the Live Subs workflow it was filed into. The website columns are only a
 * program signal on a tenant that RUNS that program.
 *
 * Matches the OASIS portal's tenantSlugs (lib/portals/registry.ts) plus
 * oasis-webdev, the scraped-prospect workspace where the reps work.
 */
const WEBSITE_SALES_TENANT_SLUGS = new Set(["oasis", "oasis-ai-cc", "oasis-webdev"]);

/** Does this tenant run the website-sales program? Fails closed on null. */
export function isWebsiteSalesTenantSlug(slug: string | null | undefined): boolean {
  return !!slug && WEBSITE_SALES_TENANT_SLUGS.has(slug.trim().toLowerCase());
}

/**
 * The program stamp for a lead on a KNOWN tenant — the form every shared
 * import path should use. Returns {} on any tenant that doesn't run the
 * program, whatever the row happens to contain.
 */
export function stampSalesProgramForTenant(
  data: Record<string, unknown>,
  tenantSlug: string | null | undefined,
): Record<string, string> {
  return isWebsiteSalesTenantSlug(tenantSlug) ? stampSalesProgram(data) : {};
}

/**
 * Pull the website/context fields out of an arbitrary source object
 * (a parsed CSV row, an extraction result, a cold_leads.raw blob), keeping
 * only non-empty strings. Returns {} when the source has none.
 *
 * Reads `webdev_industry` as `industry`: the OSM importer writes the former,
 * every UI reads the latter, and lib/web-leads/data.ts already collapses them.
 * Without this the same lead shows an industry on /web-leads and a blank on
 * the lead profile.
 */
export function pickWebsiteSalesFields(source: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of WEBSITE_SALES_FIELD_KEYS) {
    const raw = source[key];
    if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
  }
  if (!out.industry && typeof source.webdev_industry === "string" && source.webdev_industry.trim()) {
    out.industry = source.webdev_industry.trim();
  }
  return out;
}

/**
 * Stage normalization across two pipelines that share these routes.
 *
 * SunBiz leads move through imported → uw_sheet → … ; OASIS website-sales
 * leads move through researched → assigned → … . The two sets have zero
 * keys in common, so a stage written by the wrong vocabulary produces a row
 * the board cannot place in any column — present in the database, absent
 * from every screen.
 *
 * `intake` is the entry stage for each: an unworked OASIS lead is
 * "researched", an unworked SunBiz lead is "imported".
 */
export const OASIS_INTAKE_STAGE = "researched";
export const SUNBIZ_INTAKE_STAGE = "imported";

/** Stage keys that mean "arrived, nobody has worked it yet". */
const GENERIC_NEW_STAGES = new Set(["", "new", "new_contact", "new_lead", "intake"]);

/**
 * Resolve the stage an imported lead should land on.
 *
 * Pass `isWebsiteSales: true` for OASIS website-sales rows. A stage that is
 * already valid for that pipeline is kept; a generic/blank one becomes the
 * intake stage; a stage borrowed from the OTHER pipeline's vocabulary is
 * replaced with intake rather than written through, because writing it
 * through is what strands the row off-board.
 */
export function normalizeStageForTenant(
  rawStage: string | null | undefined,
  opts: { isWebsiteSales: boolean; validStageKeys: readonly string[] },
): string {
  const intake = opts.isWebsiteSales ? OASIS_INTAKE_STAGE : SUNBIZ_INTAKE_STAGE;
  const stage = (rawStage || "").trim().toLowerCase();
  if (GENERIC_NEW_STAGES.has(stage)) return intake;
  return opts.validStageKeys.includes(stage) ? stage : intake;
}

/**
 * The stage a website-sales lead should land on — the OASIS vocabulary
 * applied for you.
 *
 * Callers get this instead of the generic function above so that importers
 * don't each have to import the OASIS stage list. That matters beyond tidiness:
 * lib/import/ is SunBiz-portal-owned and the portal-boundary rule forbids it
 * reaching into lib/oasis-*. This module is unclassified shared ground, so the
 * knowledge lives here once and both pipelines call in.
 */
export function stageForWebsiteSalesLead(rawStage: string | null | undefined): string {
  return normalizeStageForTenant(rawStage, {
    isWebsiteSales: true,
    validStageKeys: OASIS_LEAD_STAGE_KEYS,
  });
}
