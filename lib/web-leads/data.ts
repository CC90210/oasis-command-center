/**
 * data.ts — server-side reads for the Web Leads browser.
 *
 * TENANT SCOPING IS THE AUTHORIZATION BOUNDARY. libSQL has no row-level
 * security, so every read here pins the tenant explicitly. There is no code
 * path that returns rows without it.
 *
 * DB CLIENT (verified against source, not assumed): getServiceSupabase()
 * (lib/supabase-server.ts) routes `.from()` to lib/turso-postgrest.ts's
 * TursoQueryBuilder when EMPIRE_DATA_BACKEND=turso_cloud, and to a real
 * supabase-js client otherwise — both speak the same PostgREST-builder
 * dialect. `.from(table).select(cols).eq(...)` resolves to
 * `{ data, error }` where `data` is an array of plain rows and `error` is
 * `{ message, code, details, hint } | null` (PgError shape in
 * turso-postgrest.ts). `.maybeSingle()` collapses that to a single
 * row-or-null with no error on zero rows — that's the pattern the
 * neighbouring by-id lookup (lib/manifest/data.ts's getRecord, same
 * tenant_records table) already uses, so fetchLead follows it here too
 * instead of `.limit(1)` + array indexing.
 *
 * Leads are filtered and paged IN MEMORY rather than via server-side
 * predicates: territory/city/industry are free text that must never enter a
 * filter string, and the sheet rail's counts already come from
 * leadgen_territories (see queries.ts) so this list never needs to run an
 * aggregate query — it only needs to fetch, filter, sort, and slice.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { WebLeadFilters } from "./filters";
import type { Sheet } from "./queries";

/** Oasis Web Studio. NOT SunBiz (aa04fa1f...), which this feature never reads. */
export const WEBDEV_TENANT_ID = "42423fde-be8b-454f-932a-750e8c9b743d";

export const PAGE_SIZE = 50;

export type WebLead = {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  province: string | null;
  industry: string | null;
  address: string | null;
  postal: string | null;
  websiteUrl: string | null;
  websiteCondition: string;
  auditFindings: string;
  territoryId: string | null;
  territoryName: string | null;
  osmCategory: string | null;
  firstSeen: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export function toWebLead(row: { id: string; data: Record<string, unknown> }): WebLead {
  const d = row.data || {};
  return {
    id: row.id,
    name: str(d.business_name) || str(d.name) || "Unnamed business",
    phone: str(d.phone),
    city: str(d.business_city),
    province: str(d.state),
    industry: str(d.webdev_industry) || str(d.industry),
    address: str(d.business_address),
    postal: str(d.business_zip),
    websiteUrl: str(d.website),
    // VERBATIM. Nothing in this pipeline has fetched these websites — OpenStreetMap
    // lacking a website tag means nobody mapped one, not that no site exists. A rep
    // reading a fabricated finding aloud on a live call is the worst outcome this
    // system can produce, so these two fields must never be shortened, re-worded,
    // normalised, or defaulted to a confident-sounding verdict.
    websiteCondition: str(d.website_condition) || "Not checked",
    auditFindings: str(d.audit_findings) || "Not audited yet - confirm on the call",
    territoryId: str(d.webdev_territory_id),
    territoryName: str(d.webdev_territory),
    osmCategory: str(d.webdev_osm_category),
    firstSeen: str(d.first_seen_at),
  };
}

export async function fetchSheets(): Promise<Sheet[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_territories")
    .select(
      "id,region,locality,vertical,leads_total,leads_callable,leads_no_site,leads_callable_no_site",
    )
    .eq("tenant_id", WEBDEV_TENANT_ID);
  if (error) throw new Error(`sheets_read_failed: ${error.message}`);
  return (data || [])
    .filter((r: Sheet) => (r.leads_total || 0) > 0)
    .map((r: Sheet) => ({
      id: r.id,
      region: r.region,
      locality: r.locality,
      vertical: r.vertical,
      leads_total: r.leads_total || 0,
      leads_callable: r.leads_callable || 0,
      leads_no_site: r.leads_no_site || 0,
      // Real callable-AND-no-site intersection, backfilled on the table. Do
      // NOT derive this as Math.min(leads_callable, leads_no_site) — that's
      // only an upper bound on the overlap and overstated live data by 2.7x
      // (29,573 vs a true 10,872 across 1,579 sheets). See queries.ts.
      leads_callable_no_site: r.leads_callable_no_site || 0,
    }));
}

export async function fetchLeads(
  f: WebLeadFilters,
  sheetIds: string[],
): Promise<{ leads: WebLead[]; total: number }> {
  if (sheetIds.length === 0) return { leads: [], total: 0 };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead");
  if (error) throw new Error(`leads_read_failed: ${error.message}`);

  const wanted = new Set(sheetIds);
  const q = f.query.toLowerCase();
  const all = (data || [])
    .map((r: { id: string; data: Record<string, unknown> }) => toWebLead(r))
    .filter((l) => l.territoryId && wanted.has(l.territoryId))
    .filter((l) => Boolean(l.phone))
    .filter((l) => (f.noSiteOnly ? !l.websiteUrl : true))
    .filter((l) => (q ? l.name.toLowerCase().includes(q) || (l.phone || "").includes(q) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  const start = (f.page - 1) * PAGE_SIZE;
  return { leads: all.slice(start, start + PAGE_SIZE), total: all.length };
}

export async function fetchLead(id: string): Promise<WebLead | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lead_read_failed: ${error.message}`);
  return data ? toWebLead(data as { id: string; data: Record<string, unknown> }) : null;
}
