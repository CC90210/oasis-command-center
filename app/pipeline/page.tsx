/**
 * /pipeline — OASIS lead pipeline.
 *
 * 2026-05-21 rewrite (third pass): this page renders the *literal*
 * SunBizPipelineView component now — the same one Sun Biz's catch-all
 * uses at /t/sun/leads. Only difference vs the SunBiz render is the
 * `variant="oasis"` prop, which swaps:
 *   - the column set (6 OASIS columns vs 13 SunBiz columns)
 *   - the row-model (reads d.name / d.company / d.ai_score etc.)
 *   - the SLA config (lib/oasis-sla.ts)
 *
 * Layout: stage-card grid up top, "touch first" overdue callout,
 * collapsible per-stage sections with detail rows underneath. The
 * dashboard chrome that lived around the old /pipeline rewrite
 * (funnel chart + recent inbound/outbound) is gone — CC's brief was
 * explicit that /pipeline must render exactly what Sun Biz renders.
 * The funnel + recent surfaces still exist on /today (the dashboard
 * home), so they aren't lost — just stop competing for screen real
 * estate on the lead-list view.
 *
 * 2026-06-11 tenant-aware redirect: SunBiz / non-OASIS operators
 * landing on this page saw the OASIS variant (CC's personal stages,
 * usually 0 leads to them) — a real footgun (CC bug 2026-06-11). If
 * the session belongs to a non-OASIS tenant, we redirect to that
 * tenant's catch-all leads page (e.g. /t/sun/leads for Matt/Jordan/
 * Alex). CC's own OASIS sessions still see /pipeline as-is.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader, Card, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { listRecords, type TenantRecord } from "@/lib/manifest/data";
import { safe } from "@/lib/api-helpers";
import { LeadPipelineView } from "@/components/manifest/LeadPipelineView";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { OASIS_WEBSITE_SALES_PROGRAM, filterWebsiteSalesRows, stagesForOasisRole } from "@/lib/oasis-sales-pipeline-policy";
import { attachAssignedNames, buildMemberNameMap } from "@/lib/assigned-names";
import { OASIS_WEBSITE_TENANT_SLUG } from "@/lib/website-sales-workflow";

export const dynamic = "force-dynamic";

/**
 * Slugs that render the OASIS-variant pipeline directly at /pipeline.
 * Anyone else gets redirected to their tenant-scoped catch-all leads
 * page. Add a slug here ONLY if that tenant wants /pipeline to be
 * their canonical leads URL (rare — almost everyone wants the catch-all).
 *
 * 2026-06-16 fix: CC's own OASIS empire tenant has slug "oasis-ai-cc"
 * (not "oasis"), so the original single-slug set redirected CC off his
 * own /pipeline to /t/oasis-ai-cc/leads, which 404s — breaking the OASIS
 * empire dashboard's Pipeline tab. CC's empire nav (CC_NAV) uses /pipeline
 * as the canonical leads URL, so his slug belongs here.
 */
const OASIS_PIPELINE_SLUGS = new Set(["oasis", "oasis-ai-cc", OASIS_WEBSITE_TENANT_SLUG]);

export default async function PipelinePage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string; q?: string; rep?: string }>;
}) {
  // Tenant-aware redirect. Non-OASIS operators land in their own
  // tenant's leads view rather than seeing CC's OASIS personal stages.
  // Try/catch so an unexpected DB hiccup falls through to the OASIS
  // render — strictly no worse than the pre-redirect behavior.
  // Captured for the query below: only the website-sales tenant filters rows
  // down to the website_sales_v1 program.
  let tenantSlug: string | null = null;
  try {
    const sessionResult = await resolveSessionContext();
    if (sessionResult.ok) {
      const db = getServiceSupabase();
      const tenantRow = await db
        .from("tenants")
        .select("slug")
        .eq("id", sessionResult.tenantId)
        .maybeSingle();
      const slug = (tenantRow.data as { slug: string | null } | null)?.slug;
      tenantSlug = slug ?? null;
      if (slug && !OASIS_PIPELINE_SLUGS.has(slug)) {
        redirect(`/t/${slug}/leads`);
      }
    }
  } catch (err) {
    // next/navigation's redirect() throws with digest "NEXT_REDIRECT;..."
    // to signal — re-throw so Next can complete the navigation. Any
    // other failure (DB hiccup, no session, etc.) falls through to the
    // OASIS render, strictly no worse than the pre-redirect behavior.
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      throw err;
    }
  }

  const sp = (await searchParams) || {};
  const stageFilter = typeof sp.stage === "string" && sp.stage.trim() ? sp.stage.trim() : null;
  const query = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim() : null;
  // ?rep=<auth_user_id> narrows the board to one person; ?rep=unassigned shows
  // the pool nobody owns yet.
  const repFilter = typeof sp.rep === "string" && sp.rep.trim() ? sp.rep.trim().toLowerCase() : null;

  const profile = await safe("pipeline.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  const session = await resolveSessionContext();

  if (!tenantId) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pipeline" subtitle="Sign in to see your pipeline." />
        <Card>
          <EmptyState message="No tenant on this session. Finish onboarding to connect this workspace." />
        </Card>
      </div>
    );
  }

  // Fetch every OASIS lead row in the canonical shape SunBizPipelineView
  // expects ({ id, data, updated_at, created_at }). listRecords returns
  // exactly that. Query-filter is applied client-side in the component
  // via PageSearchBar; stage filter is applied server-side here so the
  // initial render doesn't ship rows we're going to discard.
  // On oasis-webdev the program filter runs IN THE QUERY, not after the fetch:
  // that tenant holds 31k+ raw prospect rows alongside the real sales leads, so
  // capping at 500 and filtering in JS would silently drop working leads off the
  // board. Other OASIS tenants (oasis-ai-cc) have no program stamp at all and
  // must not be filtered, or their board renders empty.
  const isWebsiteSalesTenant = tenantSlug === OASIS_WEBSITE_TENANT_SLUG;
  const allRows: TenantRecord[] = await safe(
    "pipeline.rows",
    listRecords({
      tenant_id: tenantId,
      entity: "lead",
      limit: 500,
      ...(isWebsiteSalesTenant
        ? { where: { sales_program: OASIS_WEBSITE_SALES_PROGRAM } }
        : {}),
    }).then((r) => r.rows),
    [] as TenantRecord[],
  );

  // Optional ?q= filter — match across the operator-relevant fields.
  // Kept server-side so /pipeline?q=acme returns ~5 rows instead of
  // shipping 500 and filtering in the browser.
  const namedRows = await attachAssignedNames(allRows, tenantId);
  const scopedRows = session.ok
    ? filterWebsiteSalesRows(
        namedRows,
        {
          role: session.teamRole,
          userId: session.userId,
          isOwner: session.isTrueAdmin,
          adminAccess: session.adminAccess,
        },
        // The program constraint already ran in the DB query above.
        { programScoped: false },
      )
    : [];
  // WHO IS ON THE BOARD. Built from the tenant's own members, and applied
  // AFTER filterWebsiteSalesRows — never instead of it. That ordering is the
  // security property: a rep who hand-types ?rep=<someone-else> has already
  // been narrowed to their own rows, so the filter can only ever subtract from
  // what they were allowed to see. It cannot be used to look sideways.
  const repRoster = session.ok && session.isAdmin ? await buildMemberNameMap(tenantId) : new Map<string, string>();
  // RESEARCHED IS THE PROSPECT POOL, NOT PIPELINE WORK.
  //
  // CC, 2026-08-21: the board showed 30,847 untouched directory rows as a
  // pipeline stage, capped at 500, which is why it read as clogged and why
  // every profile opened thin — those are un-worked prospects, not deals.
  //
  // HIDDEN, NOT DELETED, and the distinction is load-bearing: /web-leads reads
  // the SAME rows from the SAME table and tenant (WEBDEV_TENANT_ID is
  // oasis-ai-cc). Deleting the researched leads would empty the Leads browser
  // too — there is no second copy. So the board starts at `assigned`, and
  // assigning a lead is what puts it on the pipeline.
  const workingRows = scopedRows.filter((r) => String(r.data.stage || '') !== 'researched');

  const repScopedRows = repFilter
    ? workingRows.filter((r) => {
        const owner = typeof r.data.assigned_to === "string" ? r.data.assigned_to.toLowerCase() : "";
        return repFilter === "unassigned" ? !owner : owner === repFilter;
      })
    : workingRows;

  const rows = query
    ? repScopedRows.filter((r) => {
        const d = r.data;
        const hay = [
          d.name,
          d.company,
          d.email,
          d.phone,
          d.notes,
          // Added with the leadgen fields: a rep hunting "dentists in Montreal"
          // should not have to leave the board to do it. Searching only
          // name/company/email/phone made every geographic or vertical query
          // silently return nothing, which reads as an empty pipeline rather
          // than an unsupported search.
          d.industry,
          d.business_city,
          d.website,
        ]
          .filter((v): v is string => typeof v === "string")
          .join(" ")
          .toLowerCase();
        return hay.includes(query.toLowerCase());
      })
    : scopedRows;
  const stages = session.ok
    ? stagesForOasisRole(session.teamRole, session.isTrueAdmin, session.adminAccess)
    : [];

  const repChip = (label: string, value: string | null, count: number) => {
    const active = (value ?? null) === repFilter;
    const params = new URLSearchParams();
    if (stageFilter) params.set("stage", stageFilter);
    if (query) params.set("q", query);
    if (value) params.set("rep", value);
    const href = `/pipeline${params.toString() ? `?${params.toString()}` : ""}`;
    return (
      <Link
        key={value ?? "all"}
        href={href}
        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
          active
            ? "border-accent bg-accent/15 text-accent font-semibold"
            : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg hover:border-fg-dim"
        }`}
      >
        {label} <span className="tabular-nums opacity-70">{count}</span>
      </Link>
    );
  };

  return (
    <div className="animate-fade-in space-y-4">
      {/* WHOSE BOARD. Admins and managers get one chip per rep plus the
          unassigned pool, so assigning work is a click rather than a search.
          Reps never see this row: their board is already only theirs, so a
          filter would be a list of colleagues they cannot open — an org chart
          disguised as a control. */}
      {repRoster.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-fg-dim mr-1">Rep</span>
          {repChip("Everyone", null, workingRows.length)}
          {[...repRoster.entries()].map(([id, name]) =>
            repChip(
              name,
              id,
              workingRows.filter(
                (r) => typeof r.data.assigned_to === "string" && r.data.assigned_to.toLowerCase() === id.toLowerCase(),
              ).length,
            ),
          )}
          {repChip("Unassigned", "unassigned", workingRows.filter((r) => !r.data.assigned_to).length)}
        </div>
      )}

      <LeadPipelineView
        slug="oasis"
        entityName="lead"
        entityLabel="Lead"
        stages={stages}
        stageField="stage"
        rows={rows}
        stageFilter={stageFilter}
        query={query}
        basePath="/pipeline"
        variant="oasis"
        canManage={session.ok && session.isAdmin}
      />
    </div>
  );
}
