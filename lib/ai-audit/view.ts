/**
 * lib/ai-audit/view.ts — everything the engagement page and the board show,
 * read in one place. Plain data: it crosses the server/client boundary.
 */
import "server-only";
import { briefForPage, type StoredBrief } from "@/lib/ai-audit/briefs";
import { authorizedProfile } from "@/lib/ai-audit/authorize";
import { PROFILE_EDIT_STAGES, TERMINAL_STAGES, WAITING_ON_CLIENT_STAGES, type AiAuditStage } from "@/lib/ai-audit/rules";
import { AUTHORIZE_AI_AUDIT_KIND } from "@/lib/ai-audit/authorize-payload";
import { DELIVER_AI_AUDIT_KIND } from "@/lib/ai-audit/delivery-payload";
import { FOLLOW_UP_AI_AUDIT_KIND } from "@/lib/ai-audit/follow-up-payload";
import { effectiveStatus } from "@/lib/os/approvals/rules";
import type { Client } from "@libsql/client";
import { AI_AUDIT_STAGE_LABELS, nextActionFor } from "@/lib/ai-audit/rules";
import { pipelineStageLabel, queueKey, queueLabel, type PipelineQueue } from "@/lib/ai-audit/pipeline-view";
import { leadsOnPipeline, type LeadOnPipeline } from "@/lib/ai-audit/pipeline-link";
import { auditDocIssues, type DocIssue } from "@/lib/ai-audit/doc";
import { proposalBlockers, proposalTotals, type ProposalTotals } from "@/lib/ai-audit/proposal";
import {
  getProfileVersion,
  listAuditVersions,
  listProfileFields,
  listProposalVersions,
  type AuditVersion,
  type ProfileField,
  type ProfileVersion,
  type ProposalVersion,
} from "@/lib/ai-audit/versions";
import { getEngagement, getSettings, int, listEngagements, listEvents, readLead, requireTenant, type AiAuditSettings, type AuditEvent, type Engagement } from "@/lib/ai-audit/store";
import { listCatalogue } from "@/lib/ai-audit/catalogue-store";
import type { CatalogueItem } from "@/lib/ai-audit/catalogue";
import { getShareLink, type ShareLink } from "@/lib/ai-audit/link";
import { listCheckouts, listReceipts, type Checkout, type Receipt } from "@/lib/ai-audit/payment";
import { getApprovalInTenant, parsePayload } from "@/lib/os/approvals/store";
import { listTranscripts, type Transcript } from "@/lib/ai-audit/transcripts";
import { listCallNotes, type CallNote } from "@/lib/ai-audit/call-notes";
import { latestExtraction, type ExtractionStatus } from "@/lib/ai-audit/extraction";
import { roomsForEngagement, type AuditRoom } from "@/lib/ai-audit/meet-link";
import { aiConsent } from "@/lib/ai-audit/authorize";
import { essentialGaps } from "@/lib/ai-audit/framework";
import { profileFieldDef } from "@/lib/ai-audit/profile";
import { AI_ENGINE_LABELS, validateAuthorizeAiAuditPayload, type AiEngine } from "@/lib/ai-audit/authorize-payload";
import { assumptionOverrides, latestResearch, latestResearchStep, researchTablesInstalled, type StoredResearch } from "@/lib/ai-audit/research";
import { estimateImpact, type AssumptionOverrides } from "@/lib/ai-audit/impact";
import { latestWriteStep } from "@/lib/ai-audit/writing";
import type { DocEstimate } from "@/lib/ai-audit/doc";
import { isDryRun } from "@/lib/integrations/send-mode";
import { DRY_RUN_CHANNEL } from "@/lib/ai-audit/payment";
import { AUDIT_EMAIL_CHANNEL } from "@/lib/ai-audit/delivery-payload";
import { WELCOME_APPROVAL_KEY_PREFIX } from "@/lib/ai-audit/onboarding";

/** The outcome an approval's executor recorded ("sent", "dry_run", "failed"), or null. */
function outcomeOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const r = JSON.parse(raw) as { outcome?: unknown };
    return typeof r.outcome === "string" ? r.outcome : null;
  } catch (err) {
    console.error("[ai-audit.view] an approval's recorded result is not JSON", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export type BoardRow = {
  id: string;
  lead_id: string;
  business_name: string | null;
  contact_email: string | null;
  /** The audit's step, and its name (lib/ai-audit/rules.ts). */
  stage: Engagement["stage"];
  stage_label: string;
  /** Where the lead actually is on the Pipeline: its stage key and name, and its queue ("Warm inbound"). */
  pipeline_stage: string | null;
  pipeline_stage_label: string;
  queue: string | null;
  queue_key: PipelineQueue | null;
  health: Engagement["health"];
  health_reason: string | null;
  payment_status: Engagement["payment_status"];
  next_action: string;
  is_fixture: boolean;
  /** Declined, cancelled or an active client: shown with Include closed, never counted on the Pipeline columns. */
  closed: boolean;
  updated_at: string;
};

/** One engagement as the board shows it. `lead` is its lead as the Pipeline has it; null when the lead row is gone. */
export function boardRow(e: Engagement, lead: LeadOnPipeline | null): BoardRow {
  return {
    id: e.id,
    lead_id: e.lead_id,
    business_name: e.business_name,
    contact_email: e.contact_email,
    stage: e.stage,
    stage_label: AI_AUDIT_STAGE_LABELS[e.stage],
    pipeline_stage: lead?.stage ?? null,
    pipeline_stage_label: pipelineStageLabel(lead?.stage ?? null),
    queue: queueLabel(lead?.motion ?? null),
    queue_key: queueKey(lead?.motion ?? null),
    health: e.health,
    health_reason: e.health_reason,
    payment_status: e.payment_status,
    next_action: nextActionFor(e),
    is_fixture: e.is_fixture,
    closed: !!e.closed_at,
    updated_at: e.updated_at,
  };
}

/** What the live-call screen (components/ai-audit/call/LiveCall.tsx) is drawn from, for one engagement. */
export async function liveCallProps(db: Client, tenantId: string, e: Engagement) {
  const version = e.current_profile_version_id ? await getProfileVersion(db, tenantId, e.current_profile_version_id) : null;
  const [fields, notes, brief, rooms] = await Promise.all([
    version ? listProfileFields(db, tenantId, version.id) : Promise.resolve([]),
    listCallNotes(db, tenantId, e.id),
    briefForPage(db, tenantId, e.id),
    roomsForEngagement(db, tenantId, e),
  ]);
  // The room still to be held, else the newest: its box says what became of that call's transcript.
  const open = rooms.find((r) => r.status !== "ended") ?? rooms[0] ?? null;
  return {
    brief: brief ? { hypotheses: brief.content.hypotheses, confirm: brief.content.confirm, weight: brief.content.weight } : null,
    room: open
      ? {
          code: open.code,
          title: open.title,
          status: open.status,
          recordAudio: open.recordAudio,
          guests: open.guests,
          transcript: open.transcript?.status ?? null,
          attached: !!open.attachedTranscriptId,
          holds: open.holds,
        }
      : null,
    engagementId: e.id,
    businessType: e.business_type,
    callStartedAt: e.call_started_at,
    callEndedAt: e.call_ended_at,
    notes: notes.map((n) => ({ question_id: n.question_id, notes: n.notes, row_version: n.row_version })),
    fields: fields.map((f) => ({ field_key: f.field_key, value: f.value, label: f.label })),
    editable: PROFILE_EDIT_STAGES.includes(e.stage),
  };
}

export async function boardRows(db: Client, tenantId: string, includeClosed: boolean): Promise<BoardRow[]> {
  const engagements = await listEngagements(db, tenantId, { includeClosed, limit: 300 });
  const leads = await leadsOnPipeline(db, tenantId, engagements.map((e) => e.lead_id));
  return engagements.map((e) => boardRow(e, leads.get(e.lead_id) ?? null));
}

/** The board's headline numbers (CC, 2026-10-26: "we'd rather see metrics"). Real clients only: the test prospect is left out. */
export type BoardMetrics = {
  /** Cards for an AI audit waiting in Needs you: transcripts to authorize, audits to approve, follow-ups. */
  cardsWaiting: number;
  /** Engagements flagged failed or needing a look. */
  problems: number;
  /** Before delivery and still open: discovery, research, drafting, and your reviews. */
  inProgress: number;
  /** Delivered and waiting on the client: not opened, reading, at checkout. */
  withClient: number;
  stalled: number;
  /** Paid: confirmed, onboarding or active. */
  won: number;
  /** Engagements an audit was ever delivered to: what the close rate is out of. */
  delivered: number;
  /** Every engagement ever opened, closed ones too. */
  total: number;
};

const IN_PROGRESS: readonly AiAuditStage[] = ["new_lead", "pre_call_research", "call_scheduled", "call_completed", "transcript_review", "generating", "final_review"];
const WON: readonly AiAuditStage[] = ["payment_confirmed", "onboarding", "active_client"];

export async function boardMetrics(db: Client, tenantId: string, now: Date = new Date()): Promise<BoardMetrics> {
  const t = requireTenant(tenantId);
  const m: BoardMetrics = { cardsWaiting: 0, problems: 0, inProgress: 0, withClient: 0, stalled: 0, won: 0, delivered: 0, total: 0 };
  const groups = await db.execute({ sql: "SELECT stage, health, COUNT(*) AS n FROM ai_audit_engagements WHERE tenant_id = ? AND is_fixture = 0 GROUP BY stage, health", args: [t] });
  for (const r of groups.rows) {
    const stage = String(r.stage) as AiAuditStage;
    const n = int(r.n);
    m.total += n;
    if (IN_PROGRESS.includes(stage)) m.inProgress += n;
    else if (WAITING_ON_CLIENT_STAGES.includes(stage)) m.withClient += n;
    else if (WON.includes(stage)) m.won += n;
    if (TERMINAL_STAGES.includes(stage)) continue;
    if (r.health === "stalled") m.stalled += n;
    if (r.health === "failed" || r.health === "attention") m.problems += n;
  }
  const cards = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND status = 'pending' AND action_kind IN (?, ?, ?) AND (expires_at IS NULL OR expires_at > ?)",
    args: [t, AUTHORIZE_AI_AUDIT_KIND, DELIVER_AI_AUDIT_KIND, FOLLOW_UP_AI_AUDIT_KIND, now.toISOString()],
  });
  m.cardsWaiting = int(cards.rows[0]?.n);
  const delivered = await db.execute({
    sql: `SELECT COUNT(DISTINCT ev.engagement_id) AS n FROM ai_audit_events ev
            JOIN ai_audit_engagements e ON e.tenant_id = ev.tenant_id AND e.id = ev.engagement_id
           WHERE ev.tenant_id = ? AND ev.event = 'delivered' AND e.is_fixture = 0`,
    args: [t],
  });
  m.delivered = int(delivered.rows[0]?.n);
  return m;
}

export type EngagementView = {
  engagement: Engagement;
  row: BoardRow;
  lead: { id: string; stage: string; website: string | null; city: string | null } | null;
  events: AuditEvent[];
  profile: { version: ProfileVersion; fields: ProfileField[] } | null;
  audit: AuditVersion | null;
  auditVersions: Array<Pick<AuditVersion, "id" | "version_no" | "status" | "created_at" | "delivered_at" | "pdf_sha256">>;
  auditIssues: DocIssue[];
  proposal: ProposalVersion | null;
  proposalVersions: Array<Pick<ProposalVersion, "id" | "version_no" | "status" | "total_cents" | "currency" | "created_at">>;
  proposalBlockers: string[];
  totals: ProposalTotals | null;
  deliveryApproval: { id: string; status: string; outcome: string | null; reason: string | null; message: string | null } | null;
  /** Whether an approved audit email and the client's Pay button go out for real (lib/integrations/send-mode.ts). */
  sending: { auditEmailLive: boolean; paymentsLive: boolean };
  /** The onboarding welcome email's approval card (lib/ai-audit/onboarding.ts), once filed. */
  welcome: { id: string; status: string; outcome: string | null } | null;
  link: ShareLink | null;
  checkouts: Checkout[];
  receipts: Receipt[];
  settings: AiAuditSettings;
  catalogue: CatalogueItem[];
  /** Phase 2: the call, its transcripts and Gate 1. */
  transcripts: Transcript[];
  callNotes: CallNote[];
  consentAi: boolean;
  gaps: Array<{ key: string; label: string }>;
  authorization: { id: string; status: string; outcome: string | null; message: string | null; engine: AiEngine | null; engine_label: string | null; plan: string[] } | null;
  extraction: ExtractionStatus | null;
  /** Phase 2d: the latest pre-call brief, or null before the first is built (or before bravo__241 is applied). */
  brief: StoredBrief | null;
  /** The lead's Oasis Meet rooms and what each holds for the audit (lib/ai-audit/meet-link.ts). */
  meetRooms: AuditRoom[];
  /**
   * Phase 3: the latest stored research run, the last run's status, CC's own assumption ranges, and the
   * estimates recomputed with them from the run's stored inputs. Null before bravo__243 is applied.
   */
  research: {
    latest: StoredResearch | null;
    step: { id: string; status: string; phase: string | null; error: string | null; created_at: string } | null;
    assumptions: AssumptionOverrides;
    estimates: DocEstimate[];
    /** Phase 4b: the latest model pass over the audit's opening, and what it held back. */
    writing: Awaited<ReturnType<typeof latestWriteStep>>;
  } | null;
  /** The last finished draft's report, from the profile version (lib/ai-audit/extraction.ts finishExtraction). */
  extractionReport: {
    written: string[];
    contradictions: Array<{ key: string; values: Array<{ value: unknown; from: number; to: number; source: string; quote?: string | null; transcript_id?: string | null }> }>;
    dropped: Array<{ key: string; reason: string }>;
    /** All the drops; `dropped` lists the first 100. */
    dropped_total?: number;
    failed_windows: number;
    read_windows?: number;
    summary: { goals: string[]; problems: string[]; commitments: string[]; open_questions: string[] };
  } | null;
};

export async function engagementView(db: Client, tenantId: string, engagementId: string, now: Date): Promise<EngagementView | null> {
  const engagement = await getEngagement(db, tenantId, engagementId);
  if (!engagement) return null;
  const [lead, events, auditVersions, proposalVersions, settings, catalogue, checkouts, receipts] = await Promise.all([
    readLead(db, tenantId, engagement.lead_id),
    listEvents(db, tenantId, engagement.id, 150),
    listAuditVersions(db, tenantId, engagement.id),
    listProposalVersions(db, tenantId, engagement.id),
    getSettings(db, tenantId),
    listCatalogue(db, tenantId, { includeFixture: engagement.is_fixture }),
    listCheckouts(db, tenantId, engagement.id),
    listReceipts(db, tenantId, engagement.id),
  ]);
  const profileVersion = engagement.current_profile_version_id ? await getProfileVersion(db, tenantId, engagement.current_profile_version_id) : null;
  const fields = profileVersion ? await listProfileFields(db, tenantId, profileVersion.id) : [];
  const audit = auditVersions.find((v) => v.id === engagement.current_audit_version_id) ?? null;
  const proposal = proposalVersions.find((v) => v.id === engagement.current_proposal_version_id) ?? null;
  const approval = engagement.delivery_approval_id ? await getApprovalInTenant(db, tenantId, engagement.delivery_approval_id) : null;
  const [transcripts, callNotes, extraction, brief, meetRooms] = await Promise.all([
    listTranscripts(db, tenantId, engagement.id),
    listCallNotes(db, tenantId, engagement.id),
    latestExtraction(db, tenantId, engagement.id),
    briefForPage(db, tenantId, engagement.id),
    roomsForEngagement(db, tenantId, engagement),
  ]);
  const rawReport = profileVersion?.summary && typeof profileVersion.summary === "object" ? (profileVersion.summary as Record<string, unknown>).extraction : null;
  const authApproval = engagement.authorization_approval_id ? await getApprovalInTenant(db, tenantId, engagement.authorization_approval_id) : null;
  let authPayload: ReturnType<typeof validateAuthorizeAiAuditPayload> | null = null;
  if (authApproval) {
    try {
      authPayload = validateAuthorizeAiAuditPayload(parsePayload(authApproval));
    } catch {
      authPayload = null;
    }
  }
  const captured = new Set(fields.map((f) => f.field_key));
  const authVoided =
    !!authApproval &&
    authApproval.status === "executed" &&
    !PROFILE_EDIT_STAGES.includes(engagement.stage) &&
    !TERMINAL_STAGES.includes(engagement.stage) &&
    !(await authorizedProfile(db, tenantId, engagement));
  const link = engagement.share_link_id ? await getShareLink(db, tenantId, engagement.share_link_id) : null;
  const welcomeRow = engagement.customer_id
    ? (
        await db.execute({
          sql: "SELECT id, status, expires_at, execution_result FROM approvals WHERE tenant_id = ? AND idempotency_key = ? ORDER BY revision DESC LIMIT 1",
          args: [tenantId, `${WELCOME_APPROVAL_KEY_PREFIX}${engagement.id}`],
        })
      ).rows[0]
    : undefined;
  let research: EngagementView["research"] = null;
  if (await researchTablesInstalled(db)) {
    const [latest, step, assumptions, writing] = await Promise.all([
      latestResearch(db, tenantId, engagement.id),
      latestResearchStep(db, tenantId, engagement.id),
      assumptionOverrides(db, tenantId, engagement.id),
      latestWriteStep(db, tenantId, engagement.id),
    ]);
    // A run built on an authorization that stopped holding is not shown; the tick deletes it (lib/ai-audit/research-purge.ts).
    const shown = authVoided || PROFILE_EDIT_STAGES.includes(engagement.stage) || TERMINAL_STAGES.includes(engagement.stage) ? null : latest;
    research = { latest: shown, step, assumptions, estimates: shown ? estimateImpact(shown.content.impact_inputs, assumptions).estimates : [], writing };
  }
  return {
    engagement,
    row: boardRow(engagement, lead ? { stage: lead.stage || null, motion: typeof lead.data.sales_motion === "string" ? lead.data.sales_motion : null } : null),
    lead: lead ? { id: lead.id, stage: lead.stage, website: lead.website, city: lead.city } : null,
    events,
    profile: profileVersion ? { version: profileVersion, fields } : null,
    audit,
    auditVersions: auditVersions.map((v) => ({ id: v.id, version_no: v.version_no, status: v.status, created_at: v.created_at, delivered_at: v.delivered_at, pdf_sha256: v.pdf_sha256 })),
    auditIssues: audit?.doc ? auditDocIssues(audit.doc) : [],
    proposal,
    proposalVersions: proposalVersions.map((v) => ({ id: v.id, version_no: v.version_no, status: v.status, total_cents: v.total_cents, currency: v.currency, created_at: v.created_at })),
    proposalBlockers: proposal?.content ? proposalBlockers(proposal.content, now.toISOString().slice(0, 10)) : [],
    totals: proposal?.content ? proposalTotals(proposal.content) : null,
    deliveryApproval: approval
      ? {
          id: approval.id,
          status: approval.status,
          outcome: (approval.execution_result as { outcome?: string } | null)?.outcome ?? null,
          reason: (approval.execution_result as { reason?: string } | null)?.reason ?? null,
          message: (approval.execution_result as { message?: string } | null)?.message ?? null,
        }
      : null,
    sending: { auditEmailLive: !isDryRun(AUDIT_EMAIL_CHANNEL), paymentsLive: !isDryRun(DRY_RUN_CHANNEL) },
    welcome: welcomeRow
      ? {
          id: String(welcomeRow.id),
          // A pending card past its expiry is expired, as the Feed shows it (Codex review of #749).
          status: effectiveStatus(
            { status: String(welcomeRow.status) as Parameters<typeof effectiveStatus>[0]["status"], expires_at: welcomeRow.expires_at == null ? null : String(welcomeRow.expires_at) },
            now.toISOString(),
          ),
          outcome: outcomeOf(welcomeRow.execution_result),
        }
      : null,
    link,
    checkouts,
    receipts,
    settings: settings.settings,
    catalogue: catalogue.filter((i) => i.status === "confirmed"),
    transcripts,
    callNotes,
    extraction,
    brief,
    meetRooms,
    research,
    extractionReport: rawReport && typeof rawReport === "object" ? (rawReport as EngagementView["extractionReport"]) : null,
    consentAi: aiConsent(transcripts, fields),
    gaps: essentialGaps(captured, engagement.business_type).map((key) => ({ key, label: profileFieldDef(key)?.label ?? key })),
    authorization: authApproval
      ? {
          id: authApproval.id,
          // "expired" once past its expiry, though the stored row still says pending;
          // "voided" once an executed authorization no longer holds (a transcript it covered deleted, review of phase 2).
          status: authVoided ? "voided" : effectiveStatus(authApproval, new Date().toISOString()),
          outcome: (authApproval.execution_result as { outcome?: string } | null)?.outcome ?? null,
          message: authVoided
            ? `The authorization no longer holds: something it covered changed or was deleted. ${
                engagement.stage === "final_review"
                  ? "Reopen the audit for edits, then move the audit back to Transcript to approve and authorize again."
                  : WAITING_ON_CLIENT_STAGES.includes(engagement.stage)
                    ? "Revise the audit (Revise and send again), then move the audit back to Transcript to approve and authorize again."
                    : "Move the engagement back to Transcript to approve and authorize again."
              }`
            : ((authApproval.execution_result as { message?: string } | null)?.message ?? null),
          engine: authPayload?.ok ? authPayload.value.engine : null,
          engine_label: authPayload?.ok ? AI_ENGINE_LABELS[authPayload.value.engine] : null,
          plan: authPayload?.ok ? authPayload.value.plan : [],
        }
      : null,
  };
}
