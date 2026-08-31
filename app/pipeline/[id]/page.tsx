import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader, Card } from "@/components/Card";
import { LeadTimelinePanel } from "@/components/leads/LeadTimelinePanel";
import { LeadDocumentsPanel } from "@/components/leads/LeadDocumentsPanel";
import { CollapsibleSection } from "@/components/leads/CollapsibleSection";
import { LeadActionToolbar } from "@/components/leads/LeadActionToolbar";
import { LeadWebsiteAuditBand } from "@/components/leads/LeadWebsiteAuditBand";
import { LeadContextEditor } from "@/components/leads/LeadContextEditor";
import { LeadNoteComposer } from "@/components/leads/LeadNoteComposer";
import type { BuildBriefDraft } from "@/components/leads/LeadBuildBriefForm";
import { OASIS_SEED } from "@/lib/manifest/seeds";
import { getRecord } from "@/lib/manifest/data";
import { lastTouchIso, latestTouchIso } from "@/lib/lead-staleness";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { findOasisStage, type StageMeta } from "@/lib/oasis-stage-meta";
import { OASIS_STAGE_SLA_DAYS } from "@/lib/oasis-sla";
import { nonEmptyString, relTime } from "@/lib/format-helpers";
import { BattleCard } from "@/components/web-leads/BattleCard";
import { visibleToViewer } from "@/lib/web-leads/data";
import { LeadLifecycleActions } from "./LeadLifecycleActions";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  canMutateOasisSalesRecord,
  canOpenOasisSalesRecord,
  mayOperateOasisDeliveryStage,
} from "@/lib/oasis-sales-pipeline-policy";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { mayQuoteAndClose } from "@/lib/team-roles";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { buildMemberNameMap } from "@/lib/assigned-names";
import { safeExternalUrl } from "@/lib/web-leads/url-safety";
import { websiteBuildBriefIsReady } from "@/lib/website-sales-build-brief";

export const dynamic = "force-dynamic";

export default async function PipelineLeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const leadEntity = OASIS_SEED.data_model?.find((entity) => entity.name === "lead");
  if (!leadEntity) notFound();

  const profile = await safe("pipeline.detail.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || null;
  if (!tenantId) {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader title="Pipeline" subtitle="Sign in to see leads." />
      </div>
    );
  }

  const [record, session] = await Promise.all([
    getRecord({ tenant_id: tenantId, entity: "lead", id }).catch(() => null),
    resolveSessionContext(),
  ]);

  const activeRecord =
    record &&
    session.ok &&
    canOpenOasisSalesRecord(record, {
      role: session.teamRole,
      userId: session.userId,
      isOwner: session.isTrueAdmin,
      adminAccess: session.adminAccess,
    })
      ? record
      : null;

  if (!activeRecord) {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader
          title="Lead not found"
          subtitle={`No accessible lead with id ${id.slice(0, 8)}…`}
          action={<BackToPipeline />}
        />
        <Card>
          <div className="text-sm text-fg-muted">
            The lead may have been deleted, reassigned, or the link may be stale. Use the pipeline to
            find a live record.
          </div>
        </Card>
      </div>
    );
  }

  const [ownedSlug, metrics, memberNames] = await Promise.all([
    resolveOwnedSlug(tenantId),
    loadLeadDetailMetrics(tenantId, id, activeRecord.data, activeRecord.created_at),
    buildMemberNameMap(tenantId),
  ]);

  const title =
    nonEmptyString(activeRecord.data.name) ||
    nonEmptyString(activeRecord.data.company) ||
    `Lead ${id.slice(0, 8)}`;
  const canManage = session.ok && session.isAdmin;
  const canMutateLead =
    session.ok &&
    canMutateOasisSalesRecord(activeRecord, {
      role: session.teamRole,
      userId: session.userId,
      isOwner: session.isTrueAdmin,
      adminAccess: session.adminAccess,
    });
  const assignedTo = nonEmptyString(activeRecord.data.assigned_to)?.toLowerCase();
  const repOwnsDeal =
    session.ok &&
    assignedTo === session.userId.toLowerCase();
  const canRunDeal =
    session.ok &&
    // ONE list (DEAL_CLOSING_ROLES via mayQuoteAndClose) — a hand-copied array
    // here is how UI and API drifted apart before. Ownership stays separate.
    (session.isTrueAdmin || (mayQuoteAndClose(session.teamRole) && repOwnsDeal));
  const canRunDelivery =
    session.ok && mayOperateOasisDeliveryStage(session.teamRole, metrics.stageKey);
  const canWorkLifecycle =
    (canMutateLead && session.ok && mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin)) ||
    canRunDelivery;

  // Is this a web-lead, i.e. does a battle card exist for it? Keyed on the
  // pointer JARVIS's crm-sink stamps at promotion time, the same field the
  // audit and score lookups key on. An ordinary CRM lead has no audit and
  // /api/web-leads/[id]/battlecard would 404 for it.
  const webLeadBusinessId = nonEmptyString(activeRecord.data.webdev_source_business_id);

  /**
   * ═══ TWO DOORS, TWO RULES, AND THEY DO NOT AGREE (review, 2026-08-25) ══════
   *
   * This page admits a viewer through `canOpenOasisSalesRecord`, which accepts
   * the assignee OR anyone listed in `collaborators` -- that is what makes the
   * opener-to-closer handoff work, and the comp plan pays both people.
   *
   * The battle card fetches /api/web-leads/[id]/battlecard, whose scoping runs
   * through `visibleToViewer`, and that one accepts the assignee ONLY. It has
   * no collaborator concept at all. So a collaborator opens this record and the
   * card inside it 404s.
   *
   * NOBODY IS LEFT WITH NOTHING, and that is why this is a gate rather than an
   * error left to happen: `LeadWebsiteAuditBand` renders UNCONDITIONALLY above,
   * carrying the website, the industry, the condition and the findings for
   * every viewer. So a collaborator who cannot load the card still sees the
   * business; asking the same function the API asks just means they are not
   * shown a panel that would only render an error.
   *
   * ▶ FOLLOW-UP, deliberately not done here: teach `visibleToViewer` about
   * collaborators so the two doors genuinely match rather than this page
   * routing around the gap. That widens the boundary PR #237 established and
   * deserves its own review.
   */
  const cardViewer =
    session.ok && session.userId
      ? { userId: session.userId, teamRole: session.teamRole, isAdmin: session.isAdmin }
      : null;
  const willRenderBattleCard = Boolean(
    webLeadBusinessId && cardViewer && visibleToViewer(assignedTo ?? null, cardViewer),
  );

  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader
        title={title}
        subtitle="Lead workspace · closed-loop lifecycle"
        action={<BackToPipeline />}
      />

      <CollapsibleSection
        title="Contact and business"
        storageKey="oasis.pipeline.contactBand.collapsed"
        defaultCollapsed={false}
        collapsedPreview={renderContactPreview(activeRecord.data)}
      >
        <LeadContactBand data={activeRecord.data} />
      </CollapsibleSection>

      <LeadMetricsBand metrics={metrics} canChangeStage={canWorkLifecycle} />

      {canMutateLead ? (
        <LeadActionToolbar
          leadId={id}
          displayName={title}
          phone={nonEmptyString(activeRecord.data.phone)}
          currentStage={metrics.stageKey}
        />
      ) : (
        <Card>
          <div className="text-sm font-semibold text-fg">
            {canRunDelivery ? "Builder delivery file" : "Read-only lead file"}
          </div>
          <div className="mt-1 text-sm text-fg-muted">
            {canRunDelivery
              ? "The sales history is read-only. Use the delivery lifecycle below to move this paid client through build, review, and launch."
              : "You can review this lead and its history. Only an admin or an assigned sales rep can edit context, add notes, or move the sales lifecycle."}
          </div>
        </Card>
      )}

      <LeadWebsiteAuditBand data={activeRecord.data} />

      {canWorkLifecycle ? (
        <LeadLifecycleActions
          leadId={id}
          leadName={nonEmptyString(activeRecord.data.name)}
          leadCompany={nonEmptyString(activeRecord.data.company)}
          leadEmail={nonEmptyString(activeRecord.data.email)}
          leadPhone={nonEmptyString(activeRecord.data.phone)}
          leadWebsite={nonEmptyString(activeRecord.data.website)}
          currentStage={metrics.stageKey}
          canManage={canManage}
          canRunDeal={canRunDeal}
          canRunDelivery={canRunDelivery}
          initialFounderMeetingSmsConsent={activeRecord.data.founder_meeting_sms_consent === true}
          initialOffer={{
            packageId: nonEmptyString(activeRecord.data.recommended_tier),
            setupAmount: numberValue(activeRecord.data.quoted_setup_amount),
            monthlyAmount: numberValue(activeRecord.data.quoted_monthly_amount),
            currency: nonEmptyString(activeRecord.data.currency),
            automationIds: stringArray(activeRecord.data.automation_interests),
            paymentDueAmount: numberValue(activeRecord.data.payment_due_amount),
            collectedSetupAmount: numberValue(activeRecord.data.collected_setup_amount),
            checkoutReference: nonEmptyString(activeRecord.data.stripe_checkout_session_id),
            checkoutUrl: nonEmptyString(activeRecord.data.stripe_checkout_url),
            builderUserId: nonEmptyString(activeRecord.data.fulfillment_owner_id),
          }}
          initialBuildBrief={buildBriefDraft(activeRecord.data.build_brief)}
        />
      ) : canMutateLead ? (
        <Card>
          <div className="text-sm font-semibold text-fg">Lifecycle is read-only</div>
          <div className="mt-1 text-sm text-fg-muted">
            Your account can review this lead, but only an assigned sales rep or admin can change its stage.
          </div>
        </Card>
      ) : null}

      {/*
        ═══ THE BATTLE CARD, ON THE CRM RECORD (Adon, 2026-08-25) ═════════════
        "we have to ensure that the leads tab and the pipeline are completely
        synonymous... The pipeline is how we're going to track whose lead is
        who. It should be what's going to be used more than the leads tab...
        Right now as soon as you claim a lead, you're losing a lot of the
        information that we have on the leads tab."

        He was right, and the loss was STRUCTURAL rather than a missing field.
        Claiming a lead moves it OUT of the /web-leads pool and onto the
        pipeline, and this page rendered a CRM workspace -- so the score, the
        percentile, the seven-axis profile, the named competitors, the
        everything-wrong list, the sales angles and the objection panel all
        disappeared at precisely the moment a rep committed to calling.

        THE SAME COMPONENT, NOT A PIPELINE-SHAPED COPY. It reads the same
        /api/web-leads/[id]/battlecard payload through the same authorization
        boundary, so there is no second implementation of any of it to drift.
        A second rendering of one business's failings is two things that can
        disagree mid-call.

        Placed AFTER the lifecycle actions on purpose: logging a call and
        advancing a stage are what the pipeline is FOR, and burying those
        controls under a full-height card would trade one dysfunction for
        another. Open by default -- a card behind a click is a card a rep does
        not read while a stranger is waiting.
      */}
      {willRenderBattleCard ? (
        <CollapsibleSection
          title="Website battle card"
          subtitle="The same analysis as the Leads tab: score, percentile, named competitors, what is wrong, and what to say."
          storageKey="oasis.pipeline.battleCard.collapsed"
          defaultCollapsed={false}
        >
          {/* `canMutate` mirrors the page: the card owns write controls (the
              call-outcome log), and a viewer who may not mutate this lead here
              must not be handed a writeable one inside it. */}
          <BattleCard leadId={id} canMutate={canMutateLead} embedded />
        </CollapsibleSection>
      ) : null}

      <HandoffSummary data={activeRecord.data} memberNames={memberNames} />

      {canMutateLead && ownedSlug ? (
        <LeadContextEditor leadId={id} tenantSlug={ownedSlug} initial={activeRecord.data} />
      ) : canMutateLead ? (
        <Card>
          <div className="text-sm text-fg-muted">
            This account has no workspace namespace, so lead context cannot be edited here. Ask an
            admin to finish tenant setup.
          </div>
        </Card>
      ) : null}

      {canMutateLead ? <LeadNoteComposer leadId={id} /> : null}
      <LeadTimelinePanel leadId={id} />
      <LeadDocumentsPanel tenantId={tenantId} leadId={id} />
    </div>
  );
}

function BackToPipeline() {
  return (
    <Link href="/pipeline" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Back to pipeline
    </Link>
  );
}

type LeadDetailMetrics = {
  stageKey: string;
  stageLabel: string;
  stageMeta: StageMeta | null;
  daysInStage: number | null;
  lastTouch: string | null;
  daysSinceLastTouch: number | null;
  daysSinceSlaAnchor: number | null;
  touchCount: number | null;
  nextScheduledAt: string | null;
};

async function loadLeadDetailMetrics(
  tenantId: string,
  leadId: string,
  data: Record<string, unknown>,
  recordCreatedAt: string | null,
): Promise<LeadDetailMetrics> {
  const db = getServiceSupabase();
  const stageKey = nonEmptyString(data.stage) || "researched";
  const stageMeta = findOasisStage("lead", stageKey) || null;
  const [stageEvents, interactions, touchCountResult] = await Promise.all([
    db
      .from("agent_events")
      .select("published_at, created_at, payload")
      .eq("correlation_id", tenantId)
      .in("event_type", ["BRAVO_RECORD_STATUS_CHANGED", "BRAVO_LEAD_AUTO_BUMPED"])
      .order("published_at", { ascending: false })
      .limit(50),
    db
      .from("lead_interactions")
      .select("created_at, metadata")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("lead_interactions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId),
  ]);

  const matchingInteraction = (interactions.data || []).find((row) => {
    const metadata = row.metadata as Record<string, unknown> | null;
    return metadata?.to === stageKey;
  });
  const matchingStageEvent = (stageEvents.data || []).find((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    return (
      payload &&
      (payload.lead_id === leadId || payload.record_id === leadId) &&
      payload.to === stageKey
    );
  });
  const stageSince =
    typeof matchingInteraction?.created_at === "string"
      ? matchingInteraction.created_at
      : typeof matchingStageEvent?.published_at === "string"
        ? matchingStageEvent.published_at
        : typeof matchingStageEvent?.created_at === "string"
          ? matchingStageEvent.created_at
          : nonEmptyString(data.stage_entered_at);
  const newestInteraction = interactions.data?.[0];
  const canonicalTouch = lastTouchIso({ data, created_at: null });
  const interactionTouch =
    typeof newestInteraction?.created_at === "string" &&
    Number.isFinite(Date.parse(newestInteraction.created_at))
      ? newestInteraction.created_at
      : null;
  const lastTouch = interactionTouch
    ? latestTouchIso(canonicalTouch, interactionTouch)
    : canonicalTouch;
  const slaAnchor = lastTouch || lastTouchIso({ data, created_at: recordCreatedAt });

  return {
    stageKey,
    stageLabel: stageMeta?.label || titleCase(stageKey),
    stageMeta,
    daysInStage: stageSince ? daysSince(stageSince) : null,
    lastTouch,
    daysSinceLastTouch: lastTouch ? daysSince(lastTouch) : null,
    daysSinceSlaAnchor: slaAnchor ? daysSince(slaAnchor) : null,
    touchCount: touchCountResult.error ? null : (touchCountResult.count ?? 0),
    nextScheduledAt:
      nonEmptyString(data.next_action_at) || nonEmptyString(data.founder_meeting_at),
  };
}

function LeadContactBand({ data }: { data: Record<string, unknown> }) {
  const website = nonEmptyString(data.website);
  const city = nonEmptyString(data.business_city);
  const state = nonEmptyString(data.state);
  const location = [city, state].filter(Boolean).join(", ") || null;
  return (
    <div className="grid gap-3 rounded-lg border border-bg-border bg-bg-elev/40 p-4 sm:grid-cols-2 xl:grid-cols-4">
      <ContactCell label="Contact" value={nonEmptyString(data.name)} />
      <ContactCell label="Company" value={nonEmptyString(data.company)} />
      <ContactCell
        label="Email"
        value={nonEmptyString(data.email)}
        mono
        href={nonEmptyString(data.email) ? `mailto:${nonEmptyString(data.email)}` : null}
      />
      <ContactCell
        label="Phone"
        value={nonEmptyString(data.phone)}
        mono
        href={nonEmptyString(data.phone) ? `tel:${nonEmptyString(data.phone)}` : null}
      />
      <ContactCell label="Website" value={website} href={safeExternalUrl(website)} external />
      <ContactCell label="Industry" value={nonEmptyString(data.industry)} />
      <ContactCell label="Location" value={location} />
      <ContactCell label="Source" value={nonEmptyString(data.source)} />
    </div>
  );
}

function ContactCell({
  label,
  value,
  mono = false,
  href = null,
  external = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  href?: string | null;
  external?: boolean;
}) {
  const valueClass = `mt-1 text-sm ${value ? "text-fg" : "italic text-fg-faint"} ${
    mono ? "break-all font-mono" : "break-words"
  }`;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">{label}</div>
      {value && href ? (
        <a
          href={href}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          className={`${valueClass} inline-flex max-w-full items-center gap-1.5 text-accent hover:underline`}
        >
          <span className="truncate">{value}</span>
          {external && <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />}
        </a>
      ) : (
        <div className={valueClass}>{value || "—"}</div>
      )}
    </div>
  );
}

function LeadMetricsBand({
  metrics,
  canChangeStage,
}: {
  metrics: LeadDetailMetrics;
  canChangeStage: boolean;
}) {
  const slaDays = OASIS_STAGE_SLA_DAYS[metrics.stageKey] ?? null;
  const hasSla = slaDays !== null && slaDays < 999;
  const overdueDays =
    hasSla && metrics.daysSinceSlaAnchor !== null ? metrics.daysSinceSlaAnchor - slaDays : null;
  const isOverdue = overdueDays !== null && overdueDays > 0;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricBox label="Stage">
        <div className="flex items-center gap-2">
          {canChangeStage ? (
            <a
              href="#lead-lifecycle-control"
              className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold text-white ring-offset-2 ring-offset-bg-deep transition hover:ring-2 hover:ring-accent/50"
              style={{ background: metrics.stageMeta?.bg || "#414957" }}
              title="Open lifecycle controls"
            >
              {metrics.stageLabel} · change
            </a>
          ) : (
            <span
              className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold text-white"
              style={{ background: metrics.stageMeta?.bg || "#414957" }}
            >
              {metrics.stageLabel}
            </span>
          )}
          {hasSla && <span className="font-mono text-[10px] text-fg-dim">{slaDays}d target</span>}
        </div>
        <div className="mt-2 text-xs text-fg-dim">
          {metrics.daysInStage === null
            ? "Stage history starts with the next tracked move"
            : `${metrics.daysInStage} day${metrics.daysInStage === 1 ? "" : "s"} in stage`}
        </div>
      </MetricBox>

      <MetricBox label="Last touch">
        <MetricValue>
          {metrics.daysSinceLastTouch === null
            ? "No touch logged"
            : metrics.daysSinceLastTouch === 0
              ? "Today"
              : `${metrics.daysSinceLastTouch}d ago`}
        </MetricValue>
        <div className={`mt-2 text-xs ${isOverdue ? "font-medium text-status-warm" : "text-fg-dim"}`}>
          {isOverdue
            ? `${metrics.lastTouch ? "Overdue" : "First touch overdue"} by ${overdueDays}d · ${slaDays}d target`
            : metrics.lastTouch
              ? relTime(metrics.lastTouch)
              : "Timeline is empty"}
        </div>
      </MetricBox>

      <MetricBox label="Tracked touches">
        <MetricValue>{metrics.touchCount === null ? "Unavailable" : metrics.touchCount}</MetricValue>
        <div className="mt-2 text-xs text-fg-dim">
          Calls, notes, lifecycle moves, messages, and handoffs in the interaction ledger.
        </div>
      </MetricBox>

      <MetricBox label="Next scheduled (ET)">
        <MetricValue>
          {metrics.nextScheduledAt ? formatDateTime(metrics.nextScheduledAt) : "Not scheduled"}
        </MetricValue>
        <div className="mt-2 text-xs text-fg-dim">
          {metrics.nextScheduledAt ? relTime(metrics.nextScheduledAt) : "Set the next touch or founder meeting"}
        </div>
      </MetricBox>
    </div>
  );
}

function HandoffSummary({
  data,
  memberNames,
}: {
  data: Record<string, unknown>;
  memberNames: Map<string, string>;
}) {
  const assignedId = nonEmptyString(data.assigned_to);
  const founderId = nonEmptyString(data.audit_host_user_id) || nonEmptyString(data.booked_founder);
  const assigned =
    nonEmptyString(data.assigned_to_name) ||
    (assignedId ? memberNames.get(assignedId) || assignedId : null);
  const founder = founderId ? memberNames.get(founderId) || founderId : null;
  const meetingAt = nonEmptyString(data.founder_meeting_at);
  const calendarUrl = safeExternalUrl(nonEmptyString(data.google_calendar_event_url));
  const meetUrl = safeExternalUrl(nonEmptyString(data.google_meet_link));
  const calendarStatus = humanize(nonEmptyString(data.calendar_event_status));
  return (
    <section className="rounded-2xl border border-bg-border bg-bg-deep/50 p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-fg">Handoff summary</h2>
        <p className="mt-1 text-xs text-fg-muted">
          The context the next owner needs without searching through edit fields.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCell label="Assigned rep" value={assigned} />
        <SummaryCell label="Audit host" value={founder} />
        <SummaryCell label="15-minute audit (ET)" value={meetingAt ? formatDateTime(meetingAt) : null} />
        <SummaryCell label="Calendar invite" value={calendarStatus} />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <SummaryCell
          label="Promised demo"
          value={nonEmptyString(data.promised_demo)}
          roomy
        />
        <SummaryCell
          label="Founder handoff note"
          value={nonEmptyString(data.founder_handoff_note) || nonEmptyString(data.last_handoff_note) || nonEmptyString(data.notes)}
          roomy
        />
        {nonEmptyString(data.loss_reason) && (
          <SummaryCell label="Loss reason" value={nonEmptyString(data.loss_reason)} roomy />
        )}
      </div>
      {(calendarUrl || meetUrl) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {meetUrl && (
            <a href={meetUrl} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex items-center gap-2 !px-3 !py-2 text-xs">
              Join Google Meet
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
          {calendarUrl && (
            <a href={calendarUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-2 text-xs">
              Open Calendar event
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </div>
      )}
      {websiteBuildBriefIsReady(data.build_brief) && (
        <div className="mt-4 rounded-xl border border-accent/20 bg-accent/[0.035] p-4">
          <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
            Builder-ready brief
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <SummaryCell label="Business goal" value={data.build_brief.businessGoal} roomy />
            <SummaryCell label="Ideal customer" value={data.build_brief.targetAudience} roomy />
            <SummaryCell label="Pages" value={data.build_brief.mustHavePages} roomy />
            <SummaryCell label="Required features" value={data.build_brief.requiredFeatures} roomy />
            <SummaryCell label="Integrations" value={data.build_brief.integrations} roomy />
            <SummaryCell label="Content and assets" value={data.build_brief.contentAndAssets} roomy />
            <SummaryCell label="Domain and access" value={data.build_brief.domainAndAccess} roomy />
            <SummaryCell label="Launch timing" value={data.build_brief.launchTiming} roomy />
            <SummaryCell label="Decision process" value={data.build_brief.decisionProcess} roomy />
            <SummaryCell label="Closing-call transcript notes" value={data.build_brief.transcriptNotes} roomy />
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryCell({
  label,
  value,
  roomy = false,
}: {
  label: string;
  value: string | null;
  roomy?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-bg-border/70 bg-bg-elev/30 p-3 ${roomy ? "min-h-24" : ""}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">{label}</div>
      <div className="mt-1.5 whitespace-pre-wrap break-words text-sm text-fg-muted">{value || "—"}</div>
    </div>
  );
}

function MetricBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
      <div className="text-xs font-bold uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function MetricValue({ children }: { children: ReactNode }) {
  return <div className="text-lg font-semibold leading-tight text-fg">{children}</div>;
}

function daysSince(iso: string): number {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(date);
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function humanize(value: string | null): string | null {
  return value ? titleCase(value) : null;
}

function renderContactPreview(data: Record<string, unknown>): ReactNode {
  const parts = [
    nonEmptyString(data.name),
    nonEmptyString(data.company),
    nonEmptyString(data.website),
  ].filter((value): value is string => Boolean(value));
  return parts.length ? <span className="font-mono text-xs">{parts.join(" · ")}</span> : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function buildBriefDraft(value: unknown): Partial<BuildBriefDraft> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const fields: Array<keyof BuildBriefDraft> = [
    "businessGoal",
    "targetAudience",
    "mustHavePages",
    "requiredFeatures",
    "integrations",
    "contentAndAssets",
    "domainAndAccess",
    "launchTiming",
    "decisionProcess",
    "transcriptNotes",
  ];
  const out: Partial<BuildBriefDraft> = {};
  for (const field of fields) {
    if (typeof source[field] === "string") out[field] = source[field];
  }
  return out;
}
