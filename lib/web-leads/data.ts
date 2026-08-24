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
import type { WebLeadFilters, ScoreBand, LeadSort } from "./filters";
import type { Sheet } from "./queries";
import { WEBDEV_TENANT_ID, PAGE_SIZE, LEAD_READ_CAP, assertCompleteRead } from "./tenant";
import { memo, TTL } from "./cache";
import { resolveScore, type ScoreIndex, type ScoreState } from "./scores";
import { factsFrom, isInBookOf, isReleasedFromBook } from "./claim";
import { isClaimable } from "./claim-ops";

// Re-exported so every existing import site keeps working. They live in a leaf
// module now so scores.ts can pin the same tenant and cap without creating an
// import cycle with this file -- see tenant.ts's header.
export { WEBDEV_TENANT_ID, PAGE_SIZE, LEAD_READ_CAP };

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

/**
 * A lead in the RESULTS LIST, carrying its website score.
 *
 * Deliberately a separate type from WebLead rather than two more fields on it.
 * The single-lead read (fetchLead, used by the detail route) resolves its score
 * through lib/web-leads/audit.ts, which returns the whole 49-check profile for
 * that one lead; only the list needs the cheap bulk join in
 * lib/web-leads/scores.ts. Widening WebLead would have forced every caller of
 * fetchLead to either run the bulk read for a single row or carry two fields it
 * cannot honestly populate -- and a `score` field defaulted to null on a lead
 * that IS scored reads as "not scored", which is the exact false-negative this
 * feature is built to avoid.
 */
export type WebLeadRow = WebLead & {
  score: number | null;
  scoreState: ScoreState;
  /** Auth user id of the rep who holds it, or null when it is in the pool. */
  assignedTo: string | null;
  /** Current lifecycle stage, for My Leads. */
  stage: string | null;
  /** True when a rep nominally holds this lead but the claim has lapsed -- see
   *  lib/web-leads/claim.ts. Rendered as a marker in the rep's own book rather
   *  than by silently removing the row. */
  released: boolean;
  /** When the last call was logged, so a rep can see what they have not touched. */
  lastCallAt: string | null;
};

/**
 * Which slice of the world a list read is asking for.
 *
 *   "pool" — the shared Leads tab: only leads nobody currently holds. This is
 *            what stops two reps dialling the same business.
 *   "mine" — the caller's own book, including leads whose claim has lapsed.
 */
export type LeadScope = "pool" | "mine";

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

/**
 * `scoreIndex` is INJECTED rather than fetched here so this function stays a
 * pure read of one table plus in-memory work, and so the route can fetch the
 * leads and the score index concurrently instead of serially. The route is
 * also the layer that decides what a failed score read means -- see
 * app/api/web-leads/route.ts.
 */
/**
 * Every lead row for this tenant, memoised for a few seconds.
 *
 * THIS READ IS THE 5-7 SECOND PAGE LOAD Adon reported. ~31,000 rows, each
 * carrying its full `data` JSON blob, pulled across HTTP to render fifty of
 * them. It cannot move server-side: territory, city and industry live inside
 * that blob and are free text ("Québec", "Restaurants & Bars"), and those
 * values must never enter a PostgREST filter string. That rule is a real
 * injection defence and is not being traded away for latency.
 *
 * What CAN change is how OFTEN the read happens. Caching a lead list would
 * normally be alarming -- a rep could see a lead somebody already claimed --
 * except that claiming is a compare-and-swap (claim-ops.ts). A stale pool
 * cannot produce a duplicate call; it can only produce a claim that fails, and
 * failing tells the rep the truth. Worst case is one wasted click, never a
 * wasted phone call. Full argument in lib/web-leads/cache.ts; writes invalidate
 * it immediately.
 */
async function allTenantLeads(): Promise<{ id: string; data: Record<string, unknown> }[]> {
  return memo("web-leads:leads", TTL.LEADS, async () => {
    const db = getServiceSupabase();
    const { data, error, count } = await db
      .from("tenant_records")
      .select("id,data", { count: "exact" })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .limit(LEAD_READ_CAP);
    if (error) throw new Error(`leads_read_failed: ${error.message}`);
    // A short list that LOOKS complete is worse than a loud failure. Proved
    // against the read's own match count, not against our cap -- PostgREST
    // enforces its own server-side max-rows regardless of what `.limit()` asks
    // for, and a cap comparison passes silently when that binds first. See
    // assertCompleteRead() in ./tenant.
    assertCompleteRead("leads_read", data || [], count);
    return (data || []) as { id: string; data: Record<string, unknown> }[];
  });
}

export async function fetchLeads(
  f: WebLeadFilters,
  sheetIds: string[],
  viewer: Viewer,
  scoreIndex: ScoreIndex,
  // `now` is injected, never read here, for the same reason claim.ts takes it
  // as a parameter: ownership expiry is a pure derivation over timestamps, and
  // one request must not see the clock move between filtering and paging.
  { scope, now }: { scope: LeadScope; now: number },
): Promise<{ leads: WebLeadRow[]; total: number }> {
  // A rep's own book is not confined to the sheets the filters selected, so an
  // empty sheet selection means "no leads" only for the shared pool.
  if (sheetIds.length === 0 && scope === "pool") return { leads: [], total: 0 };
  const data = await allTenantLeads();

  const wanted = new Set(sheetIds);
  const q = f.query.toLowerCase();
  const all = (data || [])
    // Scope BEFORE mapping to WebLead: assigned_to lives on the raw row and
    // is deliberately not surfaced on WebLead (see the Viewer doc comment on
    // isScopedContractor -- a scoped viewer must never receive rows outside
    // their own book, not just have them hidden client-side).
    /**
     * OWNERSHIP AND VISIBILITY, resolved together rather than as two stacked
     * filters -- because stacking them broke the feature.
     *
     * `visibleToViewer` hides every UNASSIGNED lead from an `agent`-role
     * contractor (fail closed: see its doc comment). Run before the pool
     * filter, that left exactly the people this feature is for -- outside
     * contractors selling websites -- looking at an empty pool with a Claim
     * button they could never use, because unassigned leads ARE the claimable
     * inventory. Codex caught it (2026-08-23).
     *
     *   "mine"  — strictly the caller's own book. Self-scoping by
     *             construction: isInBookOf compares against this viewer's id,
     *             so a contractor cannot widen it and #237's leak stays shut.
     *
     *   "pool"  — every lead nobody currently holds, for everyone in the
     *             tenant. This is a DELIBERATE widening for `agent`, and it is
     *             what Adon asked for: "all the accounts can assign themselves
     *             the lead." A claimable lead is in nobody's book, so there is
     *             no rep's book to leak; what #237 actually closed was reading
     *             other people's assigned leads, and that stays closed --
     *             assigned leads are exactly what the pool excludes. Volume is
     *             bounded separately by the 250-lead cap in claim.ts.
     */
    .filter((r: { id: string; data: Record<string, unknown> }) =>
      scope === "mine"
        ? isInBookOf(factsFrom(r.data || {}), viewer.userId)
        : isClaimable(r.data || {}, now),
    )
    .map((r: { id: string; data: Record<string, unknown> }): WebLeadRow => {
      const lead = toWebLead(r);
      // webdev_source_business_id is the one-way pointer JARVIS's crm-sink.js
      // stamps onto the lead at promotion (see audit.ts's header). It is
      // research plumbing, not a rep-facing fact, so it is read off the raw
      // row here and never surfaced on WebLead itself.
      const bid = typeof r.data.webdev_source_business_id === "string"
        ? r.data.webdev_source_business_id
        : null;
      const facts = factsFrom(r.data || {});
      const ownedByViewer = isInBookOf(facts, viewer.userId);
      return {
        ...lead,
        ...resolveScore(lead.websiteUrl, bid, scoreIndex),
        // A lead in the POOL can still carry a previous owner -- an expired
        // claim or a 90-day-old loss is claimable while `assigned_to` still
        // names whoever had it last. Surfacing that id would tell a contractor
        // which rep held which business, which is the kind of cross-book
        // information PR #237 closed. Non-admins see an owner id only for
        // leads in their own book; everyone else gets null, and the lead is
        // claimable either way.
        assignedTo: ownedByViewer || viewer.isAdmin ? facts.assignedTo : null,
        stage: facts.stage,
        released: isReleasedFromBook(facts, now),
        lastCallAt: facts.lastCallAt,
      };
    })
    // Sheet narrowing applies to the shared pool only. A rep's own book must
    // show every lead they hold, including any whose territory sits outside
    // the filters currently set on the Leads tab -- otherwise a rep changes a
    // filter and leads they own disappear from their own page.
    .filter((l) => (scope === "mine" ? true : l.territoryId && wanted.has(l.territoryId)))
    .filter((l) => Boolean(l.phone))
    .filter((l) => (f.noSiteOnly ? !l.websiteUrl : true))
    .filter((l) => matchesBand(l, f.band))
    .filter((l) => (q ? l.name.toLowerCase().includes(q) || (l.phone || "").includes(q) : true))
    .sort(comparatorFor(f.sort));

  const start = (f.page - 1) * PAGE_SIZE;
  return { leads: all.slice(start, start + PAGE_SIZE), total: all.length };
}

/**
 * Score-band membership. Only a `scored` lead can be in a numeric band -- an
 * unreachable or never-scored site has no number, and treating "we don't know"
 * as "under 40" would hand a rep a queue of businesses whose problems we cannot
 * actually name. `unscored` collects all three non-scored states so that work
 * is reachable rather than invisible.
 */
function matchesBand(l: WebLeadRow, band: ScoreBand): boolean {
  if (band === "all") return true;
  if (band === "unscored") return l.scoreState !== "scored";
  if (l.scoreState !== "scored" || l.score === null) return false;
  if (band === "under40") return l.score < 40;
  if (band === "mid") return l.score >= 40 && l.score < 60;
  return l.score >= 60; // sixty_plus
}

/**
 * Sort comparators. Every one of them breaks ties on name, so paging is stable:
 * without a total order, two leads with the same score can swap places between
 * requests and a rep sees the same business twice across two pages while
 * another never appears at all.
 *
 * Unscored leads sort AFTER every scored lead in both score orders (not as a
 * zero, not as a 100). A missing score is not a low score -- see scores.ts.
 */
function comparatorFor(sort: LeadSort): (a: WebLeadRow, b: WebLeadRow) => number {
  const byName = (a: WebLeadRow, b: WebLeadRow) => a.name.localeCompare(b.name);
  if (sort === "name") return byName;
  return (a, b) => {
    const aHas = a.score !== null;
    const bHas = b.score !== null;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && a.score !== b.score) {
      return sort === "score_desc" ? b.score! - a.score! : a.score! - b.score!;
    }
    return byName(a, b);
  };
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
  //
  // THIS MUST MATCH WHAT THE LIST SHOWS. fetchLeads' pool scope deliberately
  // shows an `agent`-role contractor every claimable lead, and every by-id
  // route -- detail, audit, outcome -- authorizes through here. Left as a bare
  // visibleToViewer check, a contractor saw the pool, opened a lead, and got a
  // 404; entered Call Mode and every disposition failed. A list you cannot
  // click is worse than no list, because the rep only finds out mid-call.
  // (Codex review, 2026-08-23.)
  //
  // So the two rules are the same rule: readable if it is in your book, or if
  // it is claimable by anyone. Nothing widens beyond that -- a lead somebody
  // else currently holds is still invisible, which is the property PR #237
  // closed.
  if (!canViewerRead(row.data || {}, viewer, Date.now())) return null;
  return toWebLead(row);
}

/**
 * Whether `viewer` may read this lead at all, by id.
 *
 * The single definition of by-id readability, shared by fetchLead and anything
 * else that authorizes one lead -- two independent answers to "may they see
 * it" is how the list and the detail page drift apart, which is exactly the
 * bug this replaced.
 */
export function canViewerRead(
  data: Record<string, unknown>,
  viewer: Viewer,
  now: number,
): boolean {
  const facts = factsFrom(data);
  // Unscoped roles (admins and every established role) are unchanged.
  if (!isScopedContractor(viewer)) return true;
  if (isInBookOf(facts, viewer.userId)) return true;
  return isClaimable(data, now);
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
  const { data, error, count } = await db
    .from("tenant_records")
    .select("id,data", { count: "exact" })
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .limit(LEAD_READ_CAP);
  if (error) throw new Error(`leads_read_failed: ${error.message}`);
  // Completeness proved against the read's own match count, not inferred from
  // our cap -- see assertCompleteRead() in ./tenant for what that catches.
  assertCompleteRead("leads_read", data || [], count);

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
  const { data, error, count } = await db
    .from("tenant_records")
    .select("id,data", { count: "exact" })
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .limit(LEAD_READ_CAP);
  if (error) throw new Error(`leads_read_failed: ${error.message}`);
  // Completeness proved against the read's own match count, not inferred from
  // our cap -- see assertCompleteRead() in ./tenant for what that catches.
  assertCompleteRead("leads_read", data || [], count);

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
