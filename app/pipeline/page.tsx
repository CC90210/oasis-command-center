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
import { headers } from "next/headers";
import Link from "next/link";
import { PageHeader, Card, EmptyState } from "@/components/Card";
import { LeadPipelineView } from "@/components/manifest/LeadPipelineView";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { getTenant } from "@/lib/queries";
import {
  isOasisPipelineAdmin,
  stagesForOasisWarmInboundRole,
} from "@/lib/oasis-sales-pipeline-policy";
import { buildMemberDirectory, withAssignedName } from "@/lib/assigned-names";
import { getOasisSalesRepRoster, isActiveMember } from "@/lib/team";
import { canReadOasisSalesTeamPipeline } from "@/lib/role-surfaces";
import { OASIS_WEBSITE_TENANT_SLUG } from "@/lib/website-sales-workflow";
import {
  creatableOasisStages,
  oasisBoardProgramFilter,
  oasisBoardStages,
} from "@/lib/oasis-lead-create";
import {
  listOasisPipelineWindow,
  resolveOasisPipelineAssigneeScope,
} from "@/lib/oasis-pipeline-query";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { OASIS_INBOUND_WARM_MOTION } from "@/lib/leads/canonical-lead-fields";
import { inboundQueueFromWindow, readOasisInboundQueue, type OasisInboundQueue } from "@/components/os/department/inbound-load";
import { tileCount } from "@/components/os/department/count-rules";
import { auditStepsForLeads, withAuditSteps } from "@/lib/ai-audit/pipeline-link";
import { startPagePerf, timed } from "@/lib/perf/server-timing";

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

/**
 * One `[perf] pipeline` line per render (2026-10-28), beside the layout's and
 * joined to it by cf-ray, so the board's own cost is in the logs before
 * anything about it is restructured: each awaited read as a span, the nav kind
 * (document load, client navigation, prefetch) and the isolate's line count
 * (`iso` 1-2 is a freshly started isolate, i.e. a cold start). The timed()
 * wrappers pass every value and every rejection through untouched, and each
 * return hands its element through perf.done() unchanged.
 */
export default async function PipelinePage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string; q?: string; rep?: string; page?: string; motion?: string }>;
}) {
  const perf = startPagePerf("pipeline", "/pipeline", await headers());
  // Tenant-aware redirect. Non-OASIS operators land in their own
  // tenant's leads view rather than seeing CC's OASIS personal stages.
  // Try/catch so an unexpected DB hiccup falls through to the OASIS
  // render — strictly no worse than the pre-redirect behavior.
  // Captured for the query below: every OASIS sales tenant is narrowed to the
  // cold-outbound motion, and oasis-webdev also retains its program predicate.
  const session = await timed("session", resolveSessionContext(), perf.spans);
  const tenantId = session.ok ? session.tenantId : "";
  let tenantSlug: string | null = null;
  let tenantScopeError: Error | null = null;
  try {
    if (session.ok) {
      // P1 instant-load (2026-09-01): read through the React-cache()d
      // getTenant() the layout already resolved this render, instead of a
      // second raw `tenants` round trip. getTenant collapses "read failed"
      // and "row missing" into null; both threw to the same catch below
      // before, so the failure behavior is unchanged — only the label is
      // shared now.
      const tenant = await timed("tenant", getTenant(session.tenantId), perf.spans);
      const slug = tenant?.slug;
      if (!slug) {
        throw new Error("pipeline_tenant_lookup_failed_or_slug_missing");
      }
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
      perf.done("redirect");
      throw err;
    }
    tenantScopeError = err instanceof Error ? err : new Error("pipeline_tenant_lookup_failed");
    console.error("[pipeline.tenant]", tenantScopeError);
  }

  const sp = (await searchParams) || {};
  const stageFilter = typeof sp.stage === "string" && sp.stage.trim() ? sp.stage.trim() : null;
  const query = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim() : null;
  // ?rep=<auth_user_id> narrows the board to one person; ?rep=unassigned shows
  // the pool nobody owns yet.
  const repFilter = typeof sp.rep === "string" && sp.rep.trim() ? sp.rep.trim().toLowerCase() : null;
  const requestedPage = typeof sp.page === "string" ? sp.page : null;
  const warmInbound = sp.motion === "inbound";

  if (!tenantId) {
    return perf.done("error", (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pipeline" subtitle="Sign in to see your pipeline." />
        <Card>
          <EmptyState message="No tenant on this session. Finish onboarding to connect this workspace." />
        </Card>
      </div>
    ));
  }

  if (tenantScopeError) {
    return perf.done("error", (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pipeline unavailable" subtitle="We could not verify this workspace's access boundary." />
        <Card>
          <EmptyState message="Refresh to try again. No reduced or partial lead view was shown." />
        </Card>
      </div>
    ));
  }

  // Only oasis-webdev consistently carries the legacy sales_program marker.
  // sales_motion is now the cross-tenant boundary between cold Pipeline work
  // and warm Form submissions.
  // The predicate lives in lib/oasis-lead-create.ts beside the create stamp,
  // because the stamp must satisfy it or a lead someone adds is invisible here.
  const boardFilter = oasisBoardProgramFilter(tenantSlug);
  const pipelineAdmin = session.ok
    ? isOasisPipelineAdmin(session.teamRole, session.isTrueAdmin, session.adminAccess)
    : false;
  const managerTeamRead =
    session.ok &&
    canReadOasisSalesTeamPipeline({
      teamRole: session.teamRole,
      tenantSlug,
    });

  // Optional ?q= filter — match across the operator-relevant fields.
  // Search is applied by the database before the bounded working-set read.
  // WHO IS ON THE BOARD. Admins use the tenant member directory. Managers use
  // only the server-resolved OASIS sales roster, and that same allowlist is
  // applied in the database query. A forged ?rep= id, `unassigned`, founder or
  // system id is rejected before any lead query runs.
  // The board's write surfaces (inline edits, bulk actions) post to
  // /api/manifest/<slug>/... — send the slug this tenant owns, not "oasis".
  // RESEARCHED IS THE PROSPECT POOL, NOT PIPELINE WORK.
  //
  // CC, 2026-08-21: the board showed 30,847 untouched directory rows as a
  // pipeline stage, capped at 500, which is why it read as clogged and why
  // every profile opened thin — those are un-worked prospects, not deals.
  //
  // HIDDEN, NOT DELETED. The researched rows were the pool the Prospects list
  // (/web-leads) browsed; that surface retired on 2026-10-28 and the rows stay
  // in tenant_records untouched (2,061 that day). So the board starts at
  // `assigned`, and assigning a lead is what puts it on the pipeline.
  // The STAGE LIST has to drop researched too, not just the rows. Filtering one
  // without the other leaves a permanently-empty "Researched" column on the
  // board — which reads as "we have no prospects" when the truth is the
  // opposite. An empty column is a worse lie than no column.
  //
  // oasisBoardStages is that filtered list, defined once in
  // lib/oasis-lead-create.ts so the stages a lead may be CREATED in are carved
  // out of exactly the stages this board draws.
  const stages = session.ok
    ? warmInbound
      ? stagesForOasisWarmInboundRole(
          session.teamRole,
          session.isTrueAdmin,
          session.adminAccess,
        )
      : oasisBoardStages({
          teamRole: session.teamRole,
          isOwner: session.isTrueAdmin,
          adminAccess: session.adminAccess,
        })
    : [];
  // The columns this viewer may add a lead to. Each gets a "+" (D9); the create
  // route enforces the same list, so a "+" never opens a form it would refuse.
  // Intersected with the drawn columns, so a "+" can never exist without its
  // column, even if this page ever narrows `stages` further.
  const drawnStageKeys = new Set(stages.map((stage) => stage.key));
  const creatableStageKeys = session.ok && !warmInbound
    ? creatableOasisStages({ isAdmin: session.isAdmin, teamRole: session.teamRole })
        .map((stage) => stage.key)
        .filter((key) => drawnStageKeys.has(key))
    : [];

  // ═══ START THE INDEPENDENT READ BEFORE AWAITING THE ROSTER ═══════════════
  //
  // The roster read gates the pipeline query (it supplies the assignee
  // allowlist), so it genuinely cannot be parallelised with it. resolveOwnedSlug
  // does NOT depend on it and used to sit inside the Promise.all *after* it,
  // which serialised two independent round trips behind one another.
  //
  // Measured on production, logged in as a manager (the role that actually
  // takes this branch): /pipeline has a ~1.6 s floor even when the search
  // matches nothing, so the fixed per-request work — not row volume — is what
  // this page costs. Every round trip removed from that chain is ~125-300 ms.
  //
  // Kicked off WITHOUT await so it overlaps the roster read; awaited in the
  // Promise.all below. Rejections stay attached to the promise and surface
  // there, exactly as before.
  const ownedSlugPromise = resolveOwnedSlug(tenantId);
  // The Warm inbound link's badge (CC 2026-10-16): new inbound leads in the
  // last 14 days, the SAME count as the Sales desk's "New inbound leads (14
  // days)", from the same read (components/os/department/inbound-load.ts).
  // Pipeline admins only: they are the viewers whose Warm inbound board is the
  // whole queue, so the badge never counts leads the board would not show.
  // Started here so it overlaps the reads below; a failed read logs and draws
  // no badge rather than a 0, and never takes the board down with it.
  //
  // On the plain Warm inbound view (no stage, rep, search or page) the board
  // below makes THIS read itself: same stages, program, motion, unassigned rows
  // and no cycle. The badge then takes its count from the board instead of
  // reading the same up-to-2,000 rows twice (Codex review 2026-10-16).
  const badgeOf = ({ recent }: OasisInboundQueue) =>
    recent.total > 0 || recent.truncated ? tileCount(recent.total, recent.truncated) : null;
  const badgeFromBoard = warmInbound && !stageFilter && !repFilter && !query && !requestedPage;
  const inboundBadgePromise: Promise<string | null> =
    session.ok && pipelineAdmin && !badgeFromBoard
      ? readOasisInboundQueue({
          tenantId,
          tenantSlug,
          teamRole: session.teamRole,
          isOwner: session.isTrueAdmin,
          adminAccess: session.adminAccess,
        })
          .then(badgeOf)
          .catch((error) => {
            console.error("[pipeline.inbound-badge]", error);
            return null;
          })
      : Promise.resolve(null);
  // A manager's board is a READ of their team's book. A deactivated rep's
  // closed and in-delivery leads keep assigned_to for history
  // (lib/team-activation-rules.ts "keep"), so the board scope and the names
  // include inactive reps; only the filter chips (activeIds) are active-only.
  const managerRoster = managerTeamRead
    ? await timed("roster", getOasisSalesRepRoster(tenantId, undefined, { includeInactive: true }), perf.spans)
    : [];
  const managerRepRoster = new Map(
    managerRoster.map((member) => [
      member.auth_user_id!.trim().toLowerCase(),
      (member.display_name || member.full_name || member.email).trim(),
    ]),
  );
  const managerActiveRepIds = new Set(
    managerRoster
      .filter(isActiveMember)
      .map((member) => member.auth_user_id!.trim().toLowerCase()),
  );
  const assigneeScope = resolveOasisPipelineAssigneeScope({
    isAdmin: pipelineAdmin,
    userId: session.ok ? session.userId : null,
    repFilter,
    canReadTeam: managerTeamRead,
    teamRepUserIds: [...managerRepRoster.keys()],
  });

  // Resolve the directory once. The former path fetched it once to label rows
  // and again to build the rep chips, after resolving the same session/profile
  // three times above. Start this read alongside the pipeline query instead.
  // Names cover every teammate (old rows keep a deactivated rep's name); the
  // active set decides who gets a filter chip. See buildMemberDirectory.
  const memberDirectoryPromise = managerTeamRead
    ? Promise.resolve({ names: managerRepRoster, activeIds: managerActiveRepIds })
    : buildMemberDirectory(tenantId);
  const memberNameMapPromise = memberDirectoryPromise.then((directory) => directory.names);
  // The manager's default roster and an explicit rep chip use the same bounded
  // one-read path. Treating ?rep= as a scalar scope fell back to one query per
  // lifecycle stage even though it is simply a one-member roster.
  const teamAssigneeUnion = assigneeScope.allowed
    ? assigneeScope.assignedToAny
      ?? (managerTeamRead && typeof assigneeScope.assignedTo === "string"
        ? [assigneeScope.assignedTo]
        : undefined)
    : undefined;
  const directAssignee = assigneeScope.allowed && !teamAssigneeUnion
    ? assigneeScope.assignedTo
    : undefined;

  // Read the complete bounded sales scope, then remove released claims before
  // calculating exact stage totals and the selected 100-row page. Program,
  // role/rep, working stages, and search stay server-side. Reaching the 2,000
  // row safety ceiling fails loudly instead of rendering partial counts.
  let pipelineWindow;
  let memberNameMap: Map<string, string>;
  let ownedSlug: string | null;
  try {
    [pipelineWindow, memberNameMap, ownedSlug] = await Promise.all([
      timed("window", listOasisPipelineWindow({
        tenantId,
        stageKeys: assigneeScope.allowed ? stages.map((stage) => stage.key) : [],
        requestedStage: stageFilter,
        requestedPage,
        salesProgram: boardFilter.salesProgram,
        salesMotion: warmInbound ? OASIS_INBOUND_WARM_MOTION : boardFilter.salesMotion,
        assignedTo: assigneeScope.allowed ? directAssignee : undefined,
        assignedToAny: assigneeScope.allowed ? teamAssigneeUnion : undefined,
        includeUnassigned:
          warmInbound && !repFilter && pipelineAdmin,
        viewerUserId:
          assigneeScope.allowed && !pipelineAdmin && !managerTeamRead
            ? session.ok
              ? session.userId
              : null
            : null,
        fulfillmentOwnerId:
          session.ok && session.teamRole.trim().toLowerCase() === "builder"
            ? session.userId
            : null,
        // Warm form submissions are intentionally unassigned and therefore do
        // not carry the cold-sales assignment cycle stamp. Filtering them by
        // that cycle would make the new queue look empty while the rows exist.
        cycle: warmInbound ? undefined : CURRENT_OASIS_PIPELINE_CYCLE,
        query,
      }), perf.spans),
      timed("directory_wait", memberNameMapPromise, perf.spans),
      timed("owned_slug_wait", ownedSlugPromise, perf.spans),
    ]);
  } catch (error) {
    console.error("[pipeline.rows]", error);
    return perf.done("error", (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pipeline unavailable" subtitle="The live lead query failed; no counts were guessed." />
        <Card>
          <EmptyState message="Refresh to retry. If this continues, check the Turso data connection." />
        </Card>
      </div>
    ));
  }

  const named = pipelineWindow.rows.map((row) => ({
    ...row,
    data: withAssignedName(row.data, memberNameMap),
  }));
  // ONE PIPELINE (CC, 2026-10-28): a deal with an open Free AI Audit shows the
  // audit's step on its row, for the founders who can open it. A failed read
  // draws the rows without the step.
  const auditStepsPromise = session.ok
    ? timed("audit_steps", auditStepsForLeads(named.map((row) => row.id), { tenantId, isTrueAdmin: session.isTrueAdmin }), perf.spans)
    : Promise.resolve(new Map());
  const rows = withAuditSteps(named, await auditStepsPromise);
  // Counts on the old rep chips came from the current row slice and looked
  // exact while omitting old deals. Keep the filters, but show the selected
  // board's exact total in the pipeline itself.
  const { activeIds: activeMemberIds } = await memberDirectoryPromise;
  // Both audiences' name maps carry deactivated people; a chip is a live
  // control, so only active ones get one.
  const repRoster = new Map(
    [...(session.ok && pipelineAdmin ? memberNameMap : managerRepRoster)].filter(([id]) =>
      activeMemberIds.has(id),
    ),
  );

  // A manager who also carries a book had to spot their own name in a row of
  // ten colleagues to see just their leads. Their chip is pinned first and
  // marked "(you)" instead.
  //
  // Matched case-INSENSITIVELY on purpose: the two roster paths key
  // differently. managerRepRoster lowercases auth_user_id; buildMemberNameMap
  // (the admin path, lib/assigned-names.ts:34) stores it raw. A lookup on
  // either spelling alone would render the chip for one audience and silently
  // never render it for the other — and a control that is simply absent gives
  // nobody anything to report. The roster's OWN key is what the chip then
  // sends, so the filter it produces is byte-identical to the name chip it
  // replaces.
  const viewerId = session.ok ? String(session.userId || "").trim() : "";
  const viewerRepEntry = viewerId
    ? [...repRoster.entries()].find(
        ([id]) => id.trim().toLowerCase() === viewerId.toLowerCase(),
      )
    : undefined;

  const hrefWith = (changes: { stage?: string | null; page?: number | null; rep?: string | null }) => {
    const params = new URLSearchParams();
    const nextStage = changes.stage === undefined ? pipelineWindow.activeStage : changes.stage;
    const nextRep = changes.rep === undefined ? repFilter : changes.rep;
    if (nextStage) params.set("stage", nextStage);
    if (query) params.set("q", query);
    if (nextRep) params.set("rep", nextRep);
    if (warmInbound) params.set("motion", "inbound");
    if (changes.page && changes.page > 1) params.set("page", String(changes.page));
    return `/pipeline${params.toString() ? `?${params.toString()}` : ""}`;
  };
  const stageHrefs = Object.fromEntries(
    stages.map((stage) => [stage.key, hrefWith({ stage: stage.key, page: null })]),
  );
  const inboundBadge =
    session.ok && pipelineAdmin && badgeFromBoard ? badgeOf(inboundQueueFromWindow(pipelineWindow)) : await timed("badge_wait", inboundBadgePromise, perf.spans);

  const repChip = (label: string, value: string | null) => {
    const active = (value ?? null) === repFilter;
    const params = new URLSearchParams();
    if (pipelineWindow.activeStage) params.set("stage", pipelineWindow.activeStage);
    if (query) params.set("q", query);
    if (value) params.set("rep", value);
    if (warmInbound) params.set("motion", "inbound");
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

  return perf.done("ok", (
    <div className="animate-fade-in space-y-4">
      <nav aria-label="Lead queue" className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] uppercase tracking-wider text-fg-dim">Queue</span>
        <Link
          href="/pipeline"
          className={`rounded-full border px-3 py-2 text-xs transition-colors ${
            !warmInbound
              ? "border-accent bg-accent/15 font-semibold text-accent"
              : "border-bg-border bg-bg-elev/40 text-fg-muted hover:border-fg-dim hover:text-fg"
          }`}
        >
          Cold outbound
        </Link>
        <Link
          href="/pipeline?motion=inbound"
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs transition-colors ${
            warmInbound
              ? "border-accent bg-accent/15 font-semibold text-accent"
              : "border-bg-border bg-bg-elev/40 text-fg-muted hover:border-fg-dim hover:text-fg"
          }`}
        >
          <span>Warm inbound</span>
          {inboundBadge && (
            <span
              className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white"
              title="New inbound leads in the last 14 days"
            >
              {inboundBadge}
              <span className="sr-only"> new in the last 14 days</span>
            </span>
          )}
        </Link>
      </nav>
      {/* WHOSE BOARD. Admins and managers get one chip per rep plus the
          unassigned pool, so assigning work is a click rather than a search.
          Reps never see this row: their board is already only theirs, so a
          filter would be a list of colleagues they cannot open — an org chart
          disguised as a control. */}
      {repRoster.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-fg-dim mr-1">Rep</span>
          {repChip("Everyone", null)}
          {viewerRepEntry && repChip(`${viewerRepEntry[1]} (you)`, viewerRepEntry[0])}
          {[...repRoster.entries()]
            // Not rendered twice: the pinned chip above IS this person's chip.
            .filter(([id]) => id !== viewerRepEntry?.[0])
            .map(([id, name]) => repChip(name, id))}
          {pipelineAdmin && repChip("Unassigned", "unassigned")}
        </div>
      )}

      <LeadPipelineView
        slug={ownedSlug || "oasis"}
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
        // Delete is an owner's power only (base role, never the admin_access
        // grant); /api/leads/bulk op "delete" checks the same.
        canDelete={session.ok && session.isTrueAdmin}
        // Every sales role may ADD a lead they sourced; the lead is stamped to
        // whoever created it, server-side. Administering other people's leads
        // (bulk assign, new-from-application) stays on canManage above.
        canCreateLead={creatableStageKeys.length > 0}
        creatableStageKeys={creatableStageKeys}
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
  ));
}
