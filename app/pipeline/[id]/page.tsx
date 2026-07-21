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
import { ArrowLeft } from "lucide-react";
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
import { ScoreLeadButton } from "./ScoreLeadButton";
import { NextActionButton } from "./NextActionButton";
import { LeadDocumentsPanel } from "@/components/leads/LeadDocumentsPanel";
import { LeadLifecycleActions } from "./LeadLifecycleActions";
import { CollapsibleSection } from "@/components/leads/CollapsibleSection";
import { MCAProfilePanel } from "@/components/leads/MCAProfilePanel";
import { ClairReportPanel } from "@/components/leads/ClairReportPanel";
import { LeadActionToolbar } from "@/components/leads/LeadActionToolbar";

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

  if (!record) {
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

  const title =
    (typeof record.data.name === "string" && record.data.name) ||
    (typeof record.data.company === "string" && record.data.company) ||
    `Lead ${id.slice(0, 8)}`;
  const metrics = await loadLeadDetailMetrics(tenantId, id, record.data, record.created_at);

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
        collapsedPreview={renderContactPreview(record.data)}
      >
        <LeadContactBand data={record.data} />
      </CollapsibleSection>
      <LeadMetricsBand metrics={metrics} />
      <LeadActionToolbar
        leadId={id}
        leadName={typeof record.data.name === "string" ? record.data.name : null}
        leadCompany={typeof record.data.company === "string" ? record.data.company : null}
        leadEmail={typeof record.data.email === "string" ? record.data.email : null}
        daysSinceLastTouch={metrics.daysSinceLastTouch}
        operatorEmail={profile?.email ?? null}
        operatorFullName={profile?.full_name ?? profile?.display_name ?? null}
        aiToolsSlot={
          <>
            <ScoreLeadButton
              leadId={id}
              existingScore={typeof record.data.ai_score === "number" ? record.data.ai_score : null}
              existingReasoning={typeof record.data.ai_reasoning === "string" ? record.data.ai_reasoning : null}
              existingScoredAt={typeof record.data.ai_scored_at === "string" ? record.data.ai_scored_at : null}
            />
            <NextActionButton
              leadId={id}
              existingAction={typeof record.data.ai_next_action === "string" ? record.data.ai_next_action : null}
              existingRationale={typeof record.data.ai_next_action_rationale === "string" ? record.data.ai_next_action_rationale : null}
              existingAt={typeof record.data.ai_next_action_at === "string" ? record.data.ai_next_action_at : null}
            />
          </>
        }
      />
      <LeadLifecycleActions leadId={id} currentStage={metrics.stageKey} />
      <MCAProfilePanel data={record.data} />
      <ClairReportPanel leadId={id} leadData={record.data} />
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
          initial={record.data}
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
  const stageKey = nonEmptyString(data.stage) || "new_contact";
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
