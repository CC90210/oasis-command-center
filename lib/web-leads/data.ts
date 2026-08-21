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

/**
 * OASIS AI command-center tenant (slug `oasis-ai-cc`) — where the web-design
 * leads AND the operators who work them both live. NOT SunBiz (aa04fa1f...),
 * which this feature never reads.
 *
 * Was 42423fde-be8b-454f-932a-750e8c9b743d ("Oasis Web Studio", slug
 * `oasis-webdev`) until 2026-08-20: that tenant had ZERO users, so nobody
 * could ever log in and see this feature. Repointed once the underlying
 * leadgen_territories / leadgen_businesses / tenant_records rows were
 * migrated to carry this tenant_id instead.
 */
export const WEBDEV_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

export const PAGE_SIZE = 50;

/**
 * Hard cap on rows read per fetchLeads() call. The tenant holds ~31K leads
 * today, so 50,000 is headroom, not a working limit -- this is not meant to
 * ever bind in normal operation.
 *
 * WHY THIS EXISTS: two independent reviewers flagged the missing `.limit()`
 * on this read. The fix is not that the cap is generous -- it's that hitting
 * it can never pass unnoticed. getServiceSupabase() (lib/supabase-server.ts)
 * falls back to a REAL supabase-js client whenever EMPIRE_DATA_BACKEND is not
 * "turso_cloud", and PostgREST enforces its own server-side max-rows cap on
 * every request regardless of what this code asks for. If that fallback path
 * is ever taken, an unbounded select comes back SILENTLY TRUNCATED -- no
 * error, just fewer rows than exist. The filter rail would confidently show
 * 10,872 while the table quietly showed whatever PostgREST's cap allowed,
 * and nothing would say the number was wrong. A plausible-looking wrong
 * number is the exact failure this feature exists to avoid. So fetchLeads
 * treats "returned row count >= LEAD_READ_CAP" as proof the read may be
 * incomplete and throws instead of returning a partial list -- see below.
 */
export const LEAD_READ_CAP = 50000;

/**
 * Viewer identity for lead-level visibility (PR #237, 26ecc31a). `agent` is
 * the commission-only OUTSIDE CONTRACTOR role added for website sales --
 * LEAD_SCOPING_ENABLED (lib/lead-scope.ts) defaults OFF to stage per-agent
 * scoping for SunBiz's established roles without emptying their boards
 * overnight, but a contractor sits fully inside the tenant, so a tenant
 * check alone (session.tenantId === WEBDEV_TENANT_ID) does not stop them
 * pulling all ~31K leads. #237 hardened the manifest records route so
 * `agent` is ALWAYS scoped to its own records regardless of that flag; this
 * reads the same tenant_records table through a different door and must
 * enforce the identical rule, or it reopens the exact leak #237 closed.
 */
export type Viewer = { userId: string; teamRole: string; isAdmin: boolean };

/** True for the commission-only outside-contractor role that must always be
 *  scoped to its own leads -- see the Viewer doc comment above. */
export function isScopedContractor(viewer: Viewer): boolean {
  return !viewer.isAdmin && viewer.teamRole === "agent";
}

/**
 * Whether `viewer` may see a lead whose raw `data.assigned_to` is
 * `assignedTo`. Unscoped viewers (admins, and every non-`agent` role) see
 * everything -- this mirrors lead-scope.ts's recordMatchesViewer exactly:
 * admin sees all, everyone else in an established role is unrestricted, and
 * only the outside-contractor role is locked down. A scoped viewer with no
 * assignment sees nothing (fail closed) rather than everything -- nothing
 * assigns web-leads territories yet, so a freshly added contractor is
 * SUPPOSED to see zero leads until an admin assigns them one.
 *
 * Comparison is case-insensitive to match lead-scope.ts's convention:
 * assigned_to is written from the territory's auth user id, already
 * lowercased, but this must not silently start failing if that ever isn't
 * true on some row.
 */
export function visibleToViewer(assignedTo: string | null, viewer: Viewer): boolean {
  if (!isScopedContractor(viewer)) return true;
  if (!assignedTo) return false;
  return assignedTo.trim().toLowerCase() === viewer.userId.trim().toLowerCase();
}

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
  viewer: Viewer,
): Promise<{ leads: WebLead[]; total: number }> {
  if (sheetIds.length === 0) return { leads: [], total: 0 };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .limit(LEAD_READ_CAP);
  if (error) throw new Error(`leads_read_failed: ${error.message}`);

  // Hitting the cap means the read may be truncated (see LEAD_READ_CAP doc
  // comment) -- a short list that LOOKS complete is worse than a loud
  // failure, so refuse to serve a possibly-partial dataset.
  if ((data || []).length >= LEAD_READ_CAP) {
    throw new Error(
      `leads_read_truncated: hit the ${LEAD_READ_CAP}-row cap, results would be silently incomplete`,
    );
  }

  const wanted = new Set(sheetIds);
  const q = f.query.toLowerCase();
  const all = (data || [])
    // Scope BEFORE mapping to WebLead: assigned_to lives on the raw row and
    // is deliberately not surfaced on WebLead (see the Viewer doc comment on
    // isScopedContractor -- a scoped viewer must never receive rows outside
    // their own book, not just have them hidden client-side).
    .filter((r: { id: string; data: Record<string, unknown> }) =>
      visibleToViewer(
        typeof r.data.assigned_to === "string" ? r.data.assigned_to : null,
        viewer,
      ),
    )
    .map((r: { id: string; data: Record<string, unknown> }) => toWebLead(r))
    .filter((l) => l.territoryId && wanted.has(l.territoryId))
    .filter((l) => Boolean(l.phone))
    .filter((l) => (f.noSiteOnly ? !l.websiteUrl : true))
    .filter((l) => (q ? l.name.toLowerCase().includes(q) || (l.phone || "").includes(q) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  const start = (f.page - 1) * PAGE_SIZE;
  return { leads: all.slice(start, start + PAGE_SIZE), total: all.length };
}

export async function fetchLead(id: string, viewer: Viewer): Promise<WebLead | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lead_read_failed: ${error.message}`);
  if (!data) return null;
  const row = data as { id: string; data: Record<string, unknown> };
  // A lead outside the viewer's scope must read exactly like a lead that
  // doesn't exist -- returning null here (not a distinguishable error) is
  // what lets the route answer with a 404 instead of a 403, so a scoped
  // contractor can't use this endpoint to probe which ids exist tenant-wide.
  if (!visibleToViewer(typeof row.data.assigned_to === "string" ? row.data.assigned_to : null, viewer)) {
    return null;
  }
  return toWebLead(row);
}

/**
 * Sheet counters, re-derived from only the leads a SCOPED viewer can see.
 *
 * fetchSheets() returns the fast, tenant-wide denormalized counters -- fine
 * for an unscoped viewer, but for a contractor locked to their own book
 * those counters are themselves a leak: the rail confidently showing
 * "Toronto 8,246" while the table renders zero rows tells that contractor
 * exactly how big and where the rest of the tenant's book is, which is the
 * same class of leak #237 closed on the manifest route (see the Viewer doc
 * comment). This walks every lead once, keeps only the ones visible to this
 * viewer, and re-tallies each sheet's four counters from that subset --
 * same Sheet[] shape fetchSheets() returns, so buildFacets() can't tell the
 * difference. Unscoped viewers never call this and keep the O(sheets)
 * counter path in fetchSheets() -- this is the slow path, on purpose, only
 * for the narrow audience that must never see the fast one's true numbers.
 */
export async function fetchSheetsScopedToViewer(viewer: Viewer): Promise<Sheet[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .limit(LEAD_READ_CAP);
  if (error) throw new Error(`leads_read_failed: ${error.message}`);
  if ((data || []).length >= LEAD_READ_CAP) {
    throw new Error(
      `leads_read_truncated: hit the ${LEAD_READ_CAP}-row cap, results would be silently incomplete`,
    );
  }

  type Bucket = { total: number; callable: number; noSite: number; callableNoSite: number };
  const counts = new Map<string, Bucket>();
  for (const r of (data || []) as { id: string; data: Record<string, unknown> }[]) {
    const assignedTo = typeof r.data.assigned_to === "string" ? r.data.assigned_to : null;
    if (!visibleToViewer(assignedTo, viewer)) continue;
    const lead = toWebLead(r);
    if (!lead.territoryId) continue;
    const bucket = counts.get(lead.territoryId) || { total: 0, callable: 0, noSite: 0, callableNoSite: 0 };
    bucket.total += 1;
    const callable = Boolean(lead.phone);
    const noSite = !lead.websiteUrl;
    if (callable) bucket.callable += 1;
    if (noSite) bucket.noSite += 1;
    if (callable && noSite) bucket.callableNoSite += 1;
    counts.set(lead.territoryId, bucket);
  }

  const sheets = await fetchSheets();
  return sheets.map((s) => {
    const c = counts.get(s.id) || { total: 0, callable: 0, noSite: 0, callableNoSite: 0 };
    return {
      ...s,
      leads_total: c.total,
      leads_callable: c.callable,
      leads_no_site: c.noSite,
      leads_callable_no_site: c.callableNoSite,
    };
  });
}

/**
 * A lead as the pipeline view needs it: everything WebLead already carries,
 * plus the two fields that view is built on top of and that toWebLead()
 * deliberately does NOT surface (see its neighbouring functions' comments) --
 * `stage`, which is CC's website-sales lifecycle field on the SAME row
 * (lib/website-sales.ts's WEBSITE_SALES_STAGES), and `assignedTo`, needed
 * here only so an admin viewer can filter the board to one rep. Both are read
 * directly off the raw row inside fetchPipelineLeads, not added to WebLead
 * itself -- WebLead is the shape every other web-leads surface renders, and
 * widening it would leak assignedTo into components that were never audited
 * against exposing it.
 */
export type PipelineLead = WebLead & { stage: string | null; assignedTo: string | null };

/**
 * All leads THIS ENGINE produced (see WEBDEV_TENANT_ID's doc comment: as of
 * 2026-08-20 the web-design prospecting book and OASIS's own agency-CRM
 * leads live in the SAME tenant, both as tenant_records(entity_type='lead')
 * -- tenant pinning alone does not separate them). A lead this engine
 * promoted always carries `data.webdev_territory_id` (stamped by the
 * promoter, see toWebLead's territoryId mapping); an OASIS agency-CRM lead
 * never does. So the same field that already lets fetchLeads() intersect
 * against a caller-supplied sheet list doubles here as the leadgen SOURCE
 * MARKER: requiring it non-null is what keeps the pipeline view from ever
 * rendering the agency's own book next to this feature's leads.
 *
 * Scoping mirrors fetchSheetsScopedToViewer exactly: one full tenant-pinned
 * read (capped and throwing on a possibly-truncated result, same
 * LEAD_READ_CAP contract as every other full scan in this file), then
 * visibleToViewer applied per row BEFORE mapping -- a scoped contractor must
 * never receive a row outside their own book, not just have it hidden by the
 * caller.
 */
export async function fetchPipelineLeads(viewer: Viewer): Promise<PipelineLead[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .limit(LEAD_READ_CAP);
  if (error) throw new Error(`leads_read_failed: ${error.message}`);
  if ((data || []).length >= LEAD_READ_CAP) {
    throw new Error(
      `leads_read_truncated: hit the ${LEAD_READ_CAP}-row cap, results would be silently incomplete`,
    );
  }

  return (data || [])
    .map((r: { id: string; data: Record<string, unknown> }) => r)
    .filter((r) =>
      visibleToViewer(
        typeof r.data.assigned_to === "string" ? r.data.assigned_to : null,
        viewer,
      ),
    )
    .map((r): PipelineLead => {
      const lead = toWebLead(r);
      const stage = typeof r.data.stage === "string" && r.data.stage.trim() ? r.data.stage.trim() : null;
      const assignedTo =
        typeof r.data.assigned_to === "string" && r.data.assigned_to.trim()
          ? r.data.assigned_to.trim()
          : null;
      return { ...lead, stage, assignedTo };
    })
    // The leadgen source marker: see this function's doc comment above.
    .filter((lead) => lead.territoryId !== null);
}
