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
import { safe } from "@/lib/api-helpers";
import { LeadPipelineView } from "@/components/manifest/LeadPipelineView";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  OASIS_WEBSITE_SALES_PROGRAM,
  isOasisPipelineAdmin,
  stagesForOasisRole,
} from "@/lib/oasis-sales-pipeline-policy";
import { attachAssignedNames, buildMemberNameMap } from "@/lib/assigned-names";
import { OASIS_WEBSITE_TENANT_SLUG } from "@/lib/website-sales-workflow";
import {
  OASIS_COLD_OUTBOUND_MOTION,
  isWebsiteSalesTenantSlug,
} from "@/lib/leads/canonical-lead-fields";
import {
  listOasisPipelineWindow,
  resolveOasisPipelineAssigneeScope,
} from "@/lib/oasis-pipeline-query";

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
  searchParams?: Promise<{ stage?: string; q?: string; rep?: string; page?: string }>;
}) {
  // Tenant-aware redirect. Non-OASIS operators land in their own
  // tenant's leads view rather than seeing CC's OASIS personal stages.
  // Try/catch so an unexpected DB hiccup falls through to the OASIS
  // render — strictly no worse than the pre-redirect behavior.
  // Captured for the query below: every OASIS sales tenant is narrowed to the
  // cold-outbound motion, and oasis-webdev also retains its program predicate.
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
  const requestedPage = typeof sp.page === "string" ? sp.page : null;

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

  // Only oasis-webdev consistently carries the legacy sales_program marker.
  // sales_motion is now the cross-tenant boundary between cold Pipeline work
  // and warm Form submissions.
  const isWebsiteSalesTenant = tenantSlug === OASIS_WEBSITE_TENANT_SLUG;

  // Optional ?q= filter — match across the operator-relevant fields.
  // Search is applied by the database before each bounded stage window.
  // WHO IS ON THE BOARD. Built from the tenant's own members, and applied
  // AFTER filterWebsiteSalesRows — never instead of it. That ordering is the
  // security property: a rep who hand-types ?rep=<someone-else> has already
  // been narrowed to their own rows, so the filter can only ever subtract from
  // what they were allowed to see. It cannot be used to look sideways.
  // The board's write surfaces (inline edits, bulk actions) post to
  // /api/manifest/<slug>/... — send the slug this tenant owns, not "oasis".
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
  // The STAGE LIST has to drop researched too, not just the rows. Filtering one
  // without the other leaves a permanently-empty "Researched" column on the
  // board — which reads as "we have no prospects" when the truth is the
  // opposite: 30,847 of them, deliberately parked in /web-leads until a rep
  // picks one up. An empty column is a worse lie than no column.
  const stages = (session.ok
    ? stagesForOasisRole(session.teamRole, session.isTrueAdmin, session.adminAccess)
    : []
  ).filter((stage) => stage.key !== "researched");

  const pipelineAdmin = session.ok
    ? isOasisPipelineAdmin(session.teamRole, session.isTrueAdmin, session.adminAccess)
    : false;
  const assigneeScope = resolveOasisPipelineAssigneeScope({
    isAdmin: pipelineAdmin,
    userId: session.ok ? session.userId : null,
    repFilter,
  });

  // Bounded, database-first windows. Overview mode fetches at most 40 newest
  // rows per stage with exact totals; a selected stage exposes every older row
  // through 100-row pages. Program, role/rep, working stage and search all run
  // before range(), so neither old deals nor search hits can disappear behind
  // the former global 500-row cap. Legacy OASIS tenants omit only the program
  // predicate; migration 161 gives their cold working rows the motion marker.
  let pipelineWindow;
  try {
    pipelineWindow = await listOasisPipelineWindow({
      tenantId,
      stageKeys: assigneeScope.allowed ? stages.map((stage) => stage.key) : [],
      requestedStage: stageFilter,
      requestedPage,
      salesProgram: isWebsiteSalesTenant ? OASIS_WEBSITE_SALES_PROGRAM : null,
      salesMotion: isWebsiteSalesTenantSlug(tenantSlug) ? OASIS_COLD_OUTBOUND_MOTION : null,
      assignedTo: assigneeScope.allowed ? assigneeScope.assignedTo : undefined,
      query,
    });
  } catch (error) {
    console.error("[pipeline.rows]", error);
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pipeline unavailable" subtitle="The live lead query failed; no counts were guessed." />
        <Card>
          <EmptyState message="Refresh to retry. If this continues, check the Turso data connection." />
        </Card>
      </div>
    );
  }

  const rows = await attachAssignedNames(pipelineWindow.rows, tenantId);
  // Counts on the old rep chips came from the current row slice and looked
  // exact while omitting old deals. Keep the filters, but show the selected
  // board's exact total in the pipeline itself.
  const repRoster = session.ok && pipelineAdmin ? await buildMemberNameMap(tenantId) : new Map<string, string>();
  const ownedSlug = (await resolveOwnedSlug(tenantId)) || "oasis";

  const hrefWith = (changes: { stage?: string | null; page?: number | null; rep?: string | null }) => {
    const params = new URLSearchParams();
    const nextStage = changes.stage === undefined ? pipelineWindow.activeStage : changes.stage;
    const nextRep = changes.rep === undefined ? repFilter : changes.rep;
    if (nextStage) params.set("stage", nextStage);
    if (query) params.set("q", query);
    if (nextRep) params.set("rep", nextRep);
    if (changes.page && changes.page > 1) params.set("page", String(changes.page));
    return `/pipeline${params.toString() ? `?${params.toString()}` : ""}`;
  };
  const stageHrefs = Object.fromEntries(
    stages.map((stage) => [stage.key, hrefWith({ stage: stage.key, page: null })]),
  );

  const repChip = (label: string, value: string | null) => {
    const active = (value ?? null) === repFilter;
    const params = new URLSearchParams();
    if (pipelineWindow.activeStage) params.set("stage", pipelineWindow.activeStage);
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
        {label}
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
          {repChip("Everyone", null)}
          {[...repRoster.entries()].map(([id, name]) => repChip(name, id))}
          {repChip("Unassigned", "unassigned")}
        </div>
      )}

      <LeadPipelineView
        slug={ownedSlug}
        entityName="lead"
        entityLabel="Lead"
        stages={stages}
        stageField="stage"
        rows={rows}
        stageFilter={pipelineWindow.activeStage}
        query={query}
        basePath="/pipeline"
        variant="oasis"
        canManage={session.ok && session.isAdmin}
        resultWindow={{
          exactStageCounts: pipelineWindow.stageCounts,
          exactTotal: pipelineWindow.total,
          activeStage: pipelineWindow.activeStage,
          page: pipelineWindow.page,
          pageSize: pipelineWindow.pageSize,
          shownFrom: pipelineWindow.shownFrom,
          shownTo: pipelineWindow.shownTo,
          hasPrevious: pipelineWindow.hasPrevious,
          hasNext: pipelineWindow.hasNext,
          truncatedStages: pipelineWindow.truncatedStages,
          stageHrefs,
          allStagesHref: hrefWith({ stage: null, page: null }),
          previousHref: pipelineWindow.hasPrevious
            ? hrefWith({ page: pipelineWindow.page - 1 })
            : null,
          nextHref: pipelineWindow.hasNext ? hrefWith({ page: pipelineWindow.page + 1 }) : null,
        }}
      />
    </div>
  );
}
