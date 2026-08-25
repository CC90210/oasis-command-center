/**
 * /pipeline/[id] — lead detail page on the empire side.
 *
 * Mirrors the record-detail logic in app/t/[slug]/[...path]/page.tsx but
 * routed under /pipeline so the OASIS CRM feels like one continuous
 * surface instead of bouncing the operator into the tenant route. Reuses
 * ManifestRecordForm in edit mode against the OASIS_SEED lead entity —
 * every field on the record is visible + editable on one screen with no
 * separate detail primitive.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, BarChart3, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { PageHeader, Card } from "@/components/Card";
import { ManifestRecordForm } from "@/components/manifest/ManifestRecordForm";
import { LeadTimelinePanel } from "@/components/leads/LeadTimelinePanel";
import { OASIS_SEED } from "@/lib/manifest/seeds";
import { getRecord } from "@/lib/manifest/data";
import { lastTouchIso } from "@/lib/lead-staleness";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { findOasisStage, type StageMeta } from "@/lib/oasis-stage-meta";
import { OASIS_STAGE_SLA_DAYS } from "@/lib/oasis-sla";
import { formatMoney, nonEmptyString, relTime } from "@/lib/format-helpers";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { BattleCard } from "@/components/web-leads/BattleCard";
import { ScoreLeadButton } from "./ScoreLeadButton";
import { NextActionButton } from "./NextActionButton";
import { LeadDocumentsPanel } from "@/components/leads/LeadDocumentsPanel";
import { LeadLifecycleActions } from "./LeadLifecycleActions";
import { CollapsibleSection } from "@/components/leads/CollapsibleSection";
import { MCAProfilePanel } from "@/components/leads/MCAProfilePanel";
import { LeadActionToolbar } from "@/components/leads/LeadActionToolbar";
import { resolveSessionContext } from "@/lib/api-auth";
import { canOpenOasisSalesRecord } from "@/lib/oasis-sales-pipeline-policy";

export const dynamic = "force-dynamic";

export default async function PipelineLeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const leadEntity = OASIS_SEED.data_model?.find((e) => e.name === "lead");
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

  const record = await getRecord({
    tenant_id: tenantId,
    entity: "lead",
    id,
  }).catch(() => null);

  const session = await resolveSessionContext();
  // Opening ONE record is an access question: is it mine, or am I an admin?
  // It is NOT the board's list-shaping question. Running a single record through
  // filterWebsiteSalesRows made every lead on oasis-ai-cc unopenable (31,031
  // rows, none stamped website_sales_v1) and stopped a rep opening the very
  // deal they closed once its stage moved past the five rep stages.
  const visibleRecord =
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

  if (!visibleRecord) {
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader
          title="Lead not found"
          subtitle={`No lead with id ${id.slice(0, 8)}…`}
          action={
            <Link
              href="/pipeline"
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to pipeline
            </Link>
          }
        />
        <Card>
          <div className="text-sm text-fg-muted">
            The lead may have been deleted, or the link is stale. Use the
            pipeline kanban to find a live record.
          </div>
        </Card>
      </div>
    );
  }

  const activeRecord = visibleRecord;

  const title =
    (typeof activeRecord.data.name === "string" && activeRecord.data.name) ||
    (typeof activeRecord.data.company === "string" && activeRecord.data.company) ||
    `Lead ${id.slice(0, 8)}`;
  const metrics = await loadLeadDetailMetrics(tenantId, id, activeRecord.data, activeRecord.created_at);

  // Is this a web-lead, i.e. does a battle card exist for it? Keyed on the
  // pointer JARVIS's crm-sink stamps at promotion time, which is the same field
  // the audit and score lookups key on. An ordinary CRM lead has no audit, and
  // /api/web-leads/[id]/battlecard would 404 for it.
  const webLeadBusinessId = nonEmptyString(activeRecord.data.webdev_source_business_id);

  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader
        title={title}
        subtitle={`Lead · ${leadEntity.fields.length} fields`}
        action={
          <Link
            href="/pipeline"
            className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to pipeline
          </Link>
        }
      />
      <CollapsibleSection
        title="Contact"
        storageKey="oasis.pipeline.contactBand.collapsed"
        defaultCollapsed={false}
        collapsedPreview={renderContactPreview(activeRecord.data)}
      >
        <LeadContactBand data={activeRecord.data} />
        {/* Only for leads with NO battle card below. For a web-lead the card
            carries BusinessFacts -- the full directory record -- and rendering
            a four-cell summary of the same fields directly above it is one
            business's address written on the page twice. */}
        {!webLeadBusinessId && <LeadBusinessBand data={activeRecord.data} id={activeRecord.id} />}
      </CollapsibleSection>
      <LeadMetricsBand metrics={metrics} />
      <LeadActionToolbar
        leadId={id}
        leadName={typeof activeRecord.data.name === "string" ? activeRecord.data.name : null}
        leadCompany={typeof activeRecord.data.company === "string" ? activeRecord.data.company : null}
        leadEmail={typeof activeRecord.data.email === "string" ? activeRecord.data.email : null}
        daysSinceLastTouch={metrics.daysSinceLastTouch}
        operatorEmail={profile?.email ?? null}
        operatorFullName={profile?.full_name ?? profile?.display_name ?? null}
        aiToolsSlot={
          <>
            <ScoreLeadButton
              leadId={id}
              existingScore={typeof activeRecord.data.ai_score === "number" ? activeRecord.data.ai_score : null}
              existingReasoning={typeof activeRecord.data.ai_reasoning === "string" ? activeRecord.data.ai_reasoning : null}
              existingScoredAt={typeof activeRecord.data.ai_scored_at === "string" ? activeRecord.data.ai_scored_at : null}
            />
            <NextActionButton
              leadId={id}
              existingAction={typeof activeRecord.data.ai_next_action === "string" ? activeRecord.data.ai_next_action : null}
              existingRationale={typeof activeRecord.data.ai_next_action_rationale === "string" ? activeRecord.data.ai_next_action_rationale : null}
              existingAt={typeof activeRecord.data.ai_next_action_at === "string" ? activeRecord.data.ai_next_action_at : null}
            />
          </>
        }
      />
      <LeadLifecycleActions leadId={id} currentStage={metrics.stageKey} canManage={session.ok && session.isAdmin} />

      {/*
        ═══ THE BATTLE CARD, ON THE CRM RECORD (Adon, 2026-08-25) ═════════════
        "we have to ensure that the leads tab and the pipeline are completely
        synonymous... The pipeline is how we're going to track whose lead is
        who. It should be what's going to be used more than the leads tab...
        Right now as soon as you claim a lead, you're losing a lot of the
        information that we have on the leads tab."

        That was exactly right, and it was structural rather than a missing
        field. Claiming a lead moves it OUT of the /web-leads pool and onto the
        pipeline, and the pipeline record rendered a CRM form -- so the score,
        the percentile, the seven-axis profile, the named competitors, the
        everything-wrong list, the sales angles and the objection panel all
        disappeared at precisely the moment a rep committed to calling.

        THE SAME COMPONENT, NOT A PIPELINE-SHAPED COPY. It reads the same
        /api/web-leads/[id]/battlecard payload through the same authorization
        boundary, so there is no second implementation of any of it to drift.
        A second rendering of one business's failings is two things that can
        disagree mid-call.

        Placed AFTER the lifecycle actions on purpose: logging a call and
        advancing a stage are what the pipeline is for, and burying those
        controls under a full-height card would trade one dysfunction for
        another. Open by default, because a card behind a click is a card a rep
        does not read while a stranger is waiting.

        Gated on webdev_source_business_id: an ordinary CRM lead has no audit,
        and the endpoint would 404. Non-web-leads keep LeadBusinessBand above.
      */}
      {webLeadBusinessId && (
        <CollapsibleSection
          title="Website battle card"
          subtitle="The same analysis as the Leads tab: score, percentile, named competitors, what is wrong, and what to say."
          storageKey="oasis.pipeline.battleCard.collapsed"
          defaultCollapsed={false}
        >
          <BattleCard leadId={id} embedded />
        </CollapsibleSection>
      )}

      <MCAProfilePanel data={activeRecord.data} />
      <LeadTimelinePanel leadId={id} />
      <CollapsibleSection
        title="Edit lead fields"
        subtitle={`${leadEntity.fields.length} fields — open to edit name, company, email, value, etc.`}
        storageKey="oasis.pipeline.editForm.collapsed"
        defaultCollapsed={true}
      >
        <ManifestRecordForm
          tenantSlug="oasis"
          entity={leadEntity}
          backPath="pipeline"
          backHref="/pipeline"
          initial={activeRecord.data}
          editId={id}
        />
      </CollapsibleSection>
      <LeadDocumentsPanel tenantId={tenantId} leadId={id} />
    </div>
  );
}

type LeadDetailMetrics = {
  stageKey: string;
  stageLabel: string;
  stageMeta: StageMeta | null;
  daysInStage: number | null;
  stageSince: string | null;
  lastTouch: string | null;
  daysSinceLastTouch: number | null;
  aiScore: number | null;
  aiReasoning: string | null;
  nextAction: string | null;
  nextActionRationale: string | null;
  valueEstimate: unknown;
  source: string | null;
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
  const [stageEvents, lastTouchEvent] = await Promise.all([
    db
      .from("agent_events")
      .select("published_at, created_at, payload")
      .eq("correlation_id", tenantId)
      .in("event_type", ["BRAVO_RECORD_STATUS_CHANGED", "BRAVO_LEAD_AUTO_BUMPED"])
      .order("published_at", { ascending: false })
      .limit(50),
    db
      .from("lead_interactions")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const matchingStageEvent = (stageEvents.data || []).find((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    return (
      payload &&
      (payload.lead_id === leadId || payload.record_id === leadId) &&
      payload.to === stageKey
    );
  });
  const stageSince =
    typeof matchingStageEvent?.published_at === "string"
      ? matchingStageEvent.published_at
      : typeof matchingStageEvent?.created_at === "string"
        ? matchingStageEvent.created_at
        : null;
  // Prefer the most recent lead_interactions row directly — it's the
  // source of truth for "touched at." Fall back to the canonical
  // staleness ladder (lib/lead-staleness) when no interaction is
  // logged yet. updated_at intentionally NOT in the ladder.
  const lastTouch =
    typeof lastTouchEvent.data?.created_at === "string"
      ? lastTouchEvent.data.created_at
      : lastTouchIso({ data, created_at: recordCreatedAt });
  const aiScore =
    typeof data.ai_score === "number"
      ? data.ai_score
      : typeof data.score === "number"
        ? data.score
        : null;

  return {
    stageKey,
    stageLabel: stageMeta?.label || titleCase(stageKey),
    stageMeta,
    daysInStage: stageSince ? daysSince(stageSince) : null,
    stageSince,
    lastTouch,
    daysSinceLastTouch: lastTouch ? daysSince(lastTouch) : null,
    aiScore,
    aiReasoning: nonEmptyString(data.ai_reasoning),
    nextAction: nonEmptyString(data.ai_next_action),
    nextActionRationale: nonEmptyString(data.ai_next_action_rationale),
    valueEstimate: data.value_estimate ?? data.pipeline_value ?? null,
    source: nonEmptyString(data.source),
  };
}

/**
 * LeadContactBand — sticky quick-summary at the top of the lead page
 * so an operator on a cold call has name / company / email / phone
 * in one row instead of scrolling to the form below. CC's feedback
 * 2026-05-22: "I need a quick client summary I can see within the
 * same stage, last touch, AI score, value plus score, and UI display."
 */
function LeadContactBand({ data }: { data: Record<string, unknown> }) {
  const name = nonEmptyString(data.name);
  const company = nonEmptyString(data.company);
  const email = nonEmptyString(data.email);
  const phone = nonEmptyString(data.phone);
  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <ContactCell label="Name" value={name} />
      <ContactCell label="Company" value={company} />
      <ContactCell label="Email" value={email} mono />
      <ContactCell label="Phone" value={phone} mono />
    </div>
  );
}

/**
 * LeadBusinessBand — the business itself, on the CRM record.
 *
 * Adon, 2026-08-25: "you should also be able to click and view the website as
 * well as see all of the leads information, just like on the leads tab, but on
 * the pipeline tab, which is our CRM."
 *
 * WHY NONE OF THIS NEEDED A QUERY. /pipeline and /web-leads render the SAME
 * `tenant_records` rows in the SAME tenant (ef8d389e, slug `oasis-ai-cc`).
 * Every field below was already sitting on this record and simply never
 * rendered here, which is why a rep who opened a lead from the CRM saw four
 * contact fields and no business at all.
 *
 * WHAT IS DELIBERATELY NOT HERE: a website score. It lives in
 * leadgen_site_audits, not on the lead, and resolving it needs the memoised
 * index. The battle card already does that properly, so this links to it rather
 * than growing a second, thinner version that could disagree with it.
 */
function LeadBusinessBand({ data, id }: { data: Record<string, unknown>; id: string }) {
  const city = nonEmptyString(data.business_city);
  const province = nonEmptyString(data.state);
  const industry = nonEmptyString(data.webdev_industry) || nonEmptyString(data.industry);
  const address = nonEmptyString(data.business_address);
  const postal = nonEmptyString(data.business_zip);
  const territory = nonEmptyString(data.webdev_territory);
  const websiteUrl = nonEmptyString(data.website);
  const href = preferredSiteUrl(websiteUrl);
  // VERBATIM, both. `website_condition` is OpenStreetMap's own hedged wording
  // and `audit_findings` is the crawler's. Never shortened, re-worded or turned
  // into a badge: a missing website tag means nobody mapped one, not that no
  // site exists, and a rep reading a fabricated finding aloud on a live call is
  // the worst thing this system can produce.
  const condition = nonEmptyString(data.website_condition);
  const findings = nonEmptyString(data.audit_findings);
  const place = [city, province].filter(Boolean).join(", ");

  // Nothing web-lead-shaped on this record: an ordinary CRM lead renders
  // nothing here rather than a band of six empty placeholders.
  if (!place && !industry && !address && !websiteUrl && !condition) return null;

  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ContactCell label="Location" value={place || null} />
        <ContactCell label="Industry" value={industry} />
        <ContactCell label="Address" value={[address, postal].filter(Boolean).join(", ") || null} />
        <ContactCell label="Territory" value={territory} />
      </div>
      <div className="mt-3 border-t border-bg-border/60 pt-3">
        <div className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">Website</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this website in a new tab"
              className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-[11px] font-semibold text-fg-muted transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-accent"
            >
              <ExternalLink className="h-3 w-3" />View site
            </a>
          )}
          {/* Only when this record IS a web-lead. /web-leads/<id> pins its
              lookup to WEBDEV_TENANT_ID, so the link 404s for any other
              tenant's row or a hand-typed CRM lead. Caught in review
              2026-08-25; `oasis-webdev` holds 53 real leads, so it was live. */}
          {nonEmptyString(data.webdev_source_business_id) && (
            <Link
              href={`/web-leads/${encodeURIComponent(id)}`}
              title="Open the full battle card: score, competitors, sales angles, objections"
              className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-[11px] font-semibold text-fg-muted transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-accent"
            >
              <BarChart3 className="h-3 w-3" />Battle card
            </Link>
          )}
          {websiteUrl && (
            <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim" title={websiteUrl}>
              {websiteUrl}
            </span>
          )}
        </div>
        {/* Both sentences, in every state. They once rendered only when a lead
            was NOT scored, which meant a scored lead showed neither, exactly
            when a rep has a confident number and most needs the hedge. */}
        {condition && <p className="mt-2 text-[11px] leading-snug text-fg-muted">{condition}</p>}
        {findings && <p className="mt-1 text-[11px] italic leading-snug text-fg-dim">{findings}</p>}
      </div>
    </div>
  );
}

function ContactCell({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">{label}</div>
      <div className={`mt-0.5 text-sm ${value ? "text-fg" : "text-fg-faint italic"} ${mono ? "font-mono break-all" : ""}`}>
        {value || "—"}
      </div>
    </div>
  );
}

function LeadMetricsBand({ metrics }: { metrics: LeadDetailMetrics }) {
  // Overdue framing — match the pipeline's "Touch first" callout math
  // so the operator doesn't see "5d overdue" on the kanban and "9d ago"
  // on the detail page and wonder which one's lying. Uses the SAME
  // SLA table the pipeline view uses (lib/oasis-sla.ts), applied to
  // the same days-since-last-touch number this page computes.
  const slaDays = OASIS_STAGE_SLA_DAYS[metrics.stageKey] ?? null;
  const isTerminalSla = slaDays === null || slaDays >= 999;
  const overdueDays =
    !isTerminalSla && slaDays !== null && metrics.daysSinceLastTouch !== null
      ? metrics.daysSinceLastTouch - slaDays
      : null;
  const isOverdue = overdueDays !== null && overdueDays > 0;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricBox label="Stage">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{
                background: metrics.stageMeta?.bg || "#414957",
                color: metrics.stageMeta?.fg || "#E5E7EB",
              }}
            >
              {metrics.stageLabel}
            </span>
            {slaDays !== null && !isTerminalSla && (
              <span className="text-[10px] text-fg-dim font-mono">
                {slaDays}d target
              </span>
            )}
          </div>
          <div className="mt-2 text-xs text-fg-dim">
            {metrics.daysInStage == null
              ? "Exact stage history unavailable"
              : `${metrics.daysInStage} day${metrics.daysInStage === 1 ? "" : "s"} in stage`}
          </div>
        </MetricBox>
        <MetricBox label="Last touch">
          <MetricValue>
            {metrics.daysSinceLastTouch == null
              ? "No touch logged"
              : `${metrics.daysSinceLastTouch} day${metrics.daysSinceLastTouch === 1 ? "" : "s"} ago`}
          </MetricValue>
          <div className="mt-2 text-xs">
            {isOverdue ? (
              <span className="text-status-warm font-medium">
                Overdue by {overdueDays}d
                <span className="text-fg-dim font-normal">
                  {" "}
                  ({slaDays}d target for {metrics.stageLabel})
                </span>
              </span>
            ) : (
              <span className="text-fg-dim">
                {metrics.lastTouch ? relTime(metrics.lastTouch) : "Timeline is empty"}
              </span>
            )}
          </div>
        </MetricBox>
        <MetricBox label="AI score">
          <MetricValue>{metrics.aiScore == null ? "Not scored" : `${metrics.aiScore}/100`}</MetricValue>
          <div className="mt-2 line-clamp-2 text-xs text-fg-dim">
            {metrics.aiReasoning || "Run Score with AI to generate a reasoned fit score."}
          </div>
        </MetricBox>
        <MetricBox label="Value + source">
          <MetricValue>{formatMoney(metrics.valueEstimate)}</MetricValue>
          <div className="mt-2 text-xs text-fg-dim">{metrics.source || "Source not captured"}</div>
        </MetricBox>
      </div>
      <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
        <div className="text-xs font-bold uppercase tracking-wider text-fg-muted">
          AI next action
        </div>
        <div className="mt-2 text-sm font-semibold text-fg">
          {metrics.nextAction || "No recommendation yet"}
        </div>
        <div className="mt-1 text-sm text-fg-muted">
          {metrics.nextActionRationale || "Run Suggest next action to generate the next best operator move."}
        </div>
      </div>
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
  return <div className="text-xl font-semibold text-fg">{children}</div>;
}

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Compact one-line preview rendered when the Contact section is
 * collapsed — name · company · email tag — so the operator still sees
 * the essentials at a glance without expanding the band.
 */
function renderContactPreview(data: Record<string, unknown>): ReactNode {
  const parts: string[] = [];
  const name = nonEmptyString(data.name);
  const company = nonEmptyString(data.company);
  const email = nonEmptyString(data.email);
  if (name) parts.push(name);
  if (company) parts.push(company);
  if (email) parts.push(email);
  if (parts.length === 0) return null;
  return <span className="font-mono text-xs">{parts.join(" · ")}</span>;
}
