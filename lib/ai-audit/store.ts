/**
 * lib/ai-audit/store.ts — engagements, the audit trail and settings.
 *
 * TENANCY. Every function takes the tenant from its caller (a session, or the
 * tick acting for OASIS's own workspaces) and every statement filters on it.
 * The one lookup that is not by tenant is the client's link token (link.ts).
 *
 * EVERY WRITE IS A COMPARE-AND-SWAP on row_version, in the same transaction as
 * its ai_audit_events row (casWrite), so the trail can never disagree with the
 * state and two concurrent clicks cannot both move a stage.
 */
import "server-only";
import type { Client, InStatement, Row } from "@libsql/client";
import { newId } from "@/lib/ai-audit/hash";
import {
  AI_AUDIT_STAGES,
  BUSINESS_TYPES,
  HEALTH_FLAGS,
  ONBOARDING_STATUSES,
  PAYMENT_STATUSES,
  isOneOf,
  mayMoveStage,
  type AiAuditStage,
  type BusinessType,
  type HealthFlag,
  type OnboardingStatus,
  type PaymentStatus,
} from "@/lib/ai-audit/rules";
import { validateTaxRule, type TaxRule } from "@/lib/ai-audit/proposal";
import { stopEngagementRunsStatements } from "@/lib/ai-audit/extraction-stop";

export type Engagement = {
  id: string;
  tenant_id: string;
  lead_id: string;
  cycle_no: number;
  stage: AiAuditStage;
  health: HealthFlag;
  health_reason: string | null;
  payment_status: PaymentStatus;
  business_name: string | null;
  business_type: BusinessType | null;
  contact_name: string | null;
  contact_email: string | null;
  appointment_id: string | null;
  meet_room_id: string | null;
  engine: string | null;
  current_profile_version_id: string | null;
  current_audit_version_id: string | null;
  current_proposal_version_id: string | null;
  authorization_approval_id: string | null;
  delivery_approval_id: string | null;
  share_link_id: string | null;
  customer_id: string | null;
  delivery_project_id: string | null;
  onboarding_status: OnboardingStatus;
  /** The live-call screen's clock (bravo__239). */
  call_started_at: string | null;
  call_ended_at: string | null;
  is_fixture: boolean;
  row_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_reason: string | null;
};

export type ActorType = "user" | "system" | "client" | "runner" | "stripe";
export type Actor = { type: ActorType; id: string | null };

export type AuditEvent = {
  id: string;
  event: string;
  from_stage: string | null;
  to_stage: string | null;
  actor_type: string;
  actor_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

const ENGAGEMENT_COLUMNS = [
  "id", "tenant_id", "lead_id", "cycle_no", "stage", "health", "health_reason", "payment_status",
  "business_name", "business_type", "contact_name", "contact_email", "appointment_id", "meet_room_id", "engine",
  "current_profile_version_id", "current_audit_version_id", "current_proposal_version_id",
  "authorization_approval_id", "delivery_approval_id", "share_link_id", "customer_id", "delivery_project_id",
  "onboarding_status", "call_started_at", "call_ended_at", "is_fixture", "row_version", "created_by", "created_at", "updated_at", "closed_at", "closed_reason",
].join(", ");

export function requireTenant(tenantId: string): string {
  const t = (tenantId || "").trim();
  if (!t) throw new Error("ai-audit.store: a tenant id is required");
  return t;
}

export function text(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function int(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function parseObject(v: unknown): Record<string, unknown> {
  if (typeof v !== "string" || !v) return {};
  try {
    const p = JSON.parse(v) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapEngagement(r: Row): Engagement {
  const stage = String(r.stage);
  const health = String(r.health);
  const pay = String(r.payment_status);
  const onb = String(r.onboarding_status);
  const btype = text(r.business_type);
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    lead_id: String(r.lead_id),
    cycle_no: int(r.cycle_no, 1),
    stage: isOneOf(AI_AUDIT_STAGES, stage) ? stage : "new_lead",
    health: isOneOf(HEALTH_FLAGS, health) ? health : "attention",
    health_reason: text(r.health_reason),
    payment_status: isOneOf(PAYMENT_STATUSES, pay) ? pay : "none",
    business_name: text(r.business_name),
    business_type: btype && isOneOf(BUSINESS_TYPES, btype) ? btype : null,
    contact_name: text(r.contact_name),
    contact_email: text(r.contact_email),
    appointment_id: text(r.appointment_id),
    meet_room_id: text(r.meet_room_id),
    engine: text(r.engine),
    current_profile_version_id: text(r.current_profile_version_id),
    current_audit_version_id: text(r.current_audit_version_id),
    current_proposal_version_id: text(r.current_proposal_version_id),
    authorization_approval_id: text(r.authorization_approval_id),
    delivery_approval_id: text(r.delivery_approval_id),
    share_link_id: text(r.share_link_id),
    customer_id: text(r.customer_id),
    delivery_project_id: text(r.delivery_project_id),
    onboarding_status: isOneOf(ONBOARDING_STATUSES, onb) ? onb : "not_started",
    call_started_at: text(r.call_started_at),
    call_ended_at: text(r.call_ended_at),
    is_fixture: int(r.is_fixture) === 1,
    row_version: int(r.row_version, 1),
    created_by: text(r.created_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    closed_at: text(r.closed_at),
    closed_reason: text(r.closed_reason),
  };
}

/** The audit-trail row for an action. Batched with the change it records. */
export function eventStatement(input: {
  tenantId: string;
  engagementId: string;
  event: string;
  actor: Actor;
  at: string;
  fromStage?: string | null;
  toStage?: string | null;
  refType?: string | null;
  refId?: string | null;
  meta?: Record<string, unknown>;
}): InStatement {
  return {
    sql: `INSERT INTO ai_audit_events (id, tenant_id, engagement_id, event, from_stage, to_stage, actor_type, actor_id, ref_type, ref_id, meta, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId(),
      input.tenantId,
      input.engagementId,
      input.event.slice(0, 64),
      input.fromStage ?? null,
      input.toStage ?? null,
      input.actor.type,
      input.actor.id,
      input.refType ?? null,
      input.refId ?? null,
      JSON.stringify(input.meta ?? {}).slice(0, 4_000),
      input.at,
    ],
  };
}

/**
 * Run a compare-and-swap UPDATE and, only when it changed exactly one row, the
 * statements that go with it, in one write transaction. A stale row_version
 * rolls everything back: the event, the version rows, all of it.
 */
export async function casWrite(db: Client, update: InStatement, rest: InStatement[]): Promise<boolean> {
  const tx = await db.transaction("write");
  try {
    const r = await tx.execute(update);
    if (r.rowsAffected !== 1) {
      await tx.rollback();
      return false;
    }
    if (rest.length) await tx.batch(rest);
    await tx.commit();
    return true;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // The transaction is already gone; the original error is the one to report.
    }
    throw err;
  } finally {
    tx.close();
  }
}

export async function getEngagement(db: Client, tenantId: string, id: string): Promise<Engagement | null> {
  const rs = await db.execute({
    sql: `SELECT ${ENGAGEMENT_COLUMNS} FROM ai_audit_engagements WHERE tenant_id = ? AND id = ? LIMIT 1`,
    args: [requireTenant(tenantId), id],
  });
  return rs.rows[0] ? mapEngagement(rs.rows[0]) : null;
}

export async function getOpenEngagementForLead(db: Client, tenantId: string, leadId: string): Promise<Engagement | null> {
  const rs = await db.execute({
    sql: `SELECT ${ENGAGEMENT_COLUMNS} FROM ai_audit_engagements WHERE tenant_id = ? AND lead_id = ? AND closed_at IS NULL LIMIT 1`,
    args: [requireTenant(tenantId), leadId],
  });
  return rs.rows[0] ? mapEngagement(rs.rows[0]) : null;
}

export async function listEngagementsForLead(db: Client, tenantId: string, leadId: string): Promise<Engagement[]> {
  const rs = await db.execute({
    sql: `SELECT ${ENGAGEMENT_COLUMNS} FROM ai_audit_engagements WHERE tenant_id = ? AND lead_id = ? ORDER BY cycle_no DESC`,
    args: [requireTenant(tenantId), leadId],
  });
  return rs.rows.map(mapEngagement);
}

export async function listEngagements(
  db: Client,
  tenantId: string,
  opts: { includeClosed?: boolean; limit?: number } = {},
): Promise<Engagement[]> {
  const rs = await db.execute({
    sql: `SELECT ${ENGAGEMENT_COLUMNS} FROM ai_audit_engagements
          WHERE tenant_id = ? ${opts.includeClosed ? "" : "AND closed_at IS NULL"}
          ORDER BY updated_at DESC LIMIT ?`,
    args: [requireTenant(tenantId), Math.min(Math.max(opts.limit ?? 200, 1), 500)],
  });
  return rs.rows.map(mapEngagement);
}

export async function listEvents(db: Client, tenantId: string, engagementId: string, limit = 200): Promise<AuditEvent[]> {
  const rs = await db.execute({
    sql: `SELECT id, event, from_stage, to_stage, actor_type, actor_id, ref_type, ref_id, meta, created_at
          FROM ai_audit_events WHERE tenant_id = ? AND engagement_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [requireTenant(tenantId), engagementId, Math.min(Math.max(limit, 1), 1_000)],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    event: String(r.event),
    from_stage: text(r.from_stage),
    to_stage: text(r.to_stage),
    actor_type: String(r.actor_type),
    actor_id: text(r.actor_id),
    ref_type: text(r.ref_type),
    ref_id: text(r.ref_id),
    meta: parseObject(r.meta),
    created_at: String(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Opening an engagement
// ---------------------------------------------------------------------------

export type LeadFacts = {
  id: string;
  stage: string;
  businessName: string | null;
  contactName: string | null;
  email: string | null;
  website: string | null;
  city: string | null;
  data: Record<string, unknown>;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function readLead(db: Client, tenantId: string, leadId: string): Promise<LeadFacts | null> {
  const rs = await db.execute({
    sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
    args: [requireTenant(tenantId), leadId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  const data = parseObject(row.data);
  const email = str(data.email);
  return {
    id: String(row.id),
    stage: str(data.stage) ?? "",
    businessName: str(data.company) ?? str(data.business_name),
    contactName: str(data.name) ?? str(data.contact_name) ?? str(data.owner_name),
    email: email ? email.toLowerCase() : null,
    website: str(data.website),
    city: str(data.business_city) ?? str(data.city),
    data,
  };
}

export type OpenResult =
  | { ok: true; engagement: Engagement; created: boolean }
  | { ok: false; error: "lead_not_found" | "lead_lost" };

/** Open the lead's audit engagement, or hand back the one already open. */
export async function openEngagement(
  db: Client,
  input: { tenantId: string; leadId: string; actor: Actor; now: Date; isFixture?: boolean },
): Promise<OpenResult> {
  const tenantId = requireTenant(input.tenantId);
  const existing = await getOpenEngagementForLead(db, tenantId, input.leadId);
  if (existing) return { ok: true, engagement: existing, created: false };
  const lead = await readLead(db, tenantId, input.leadId);
  if (!lead) return { ok: false, error: "lead_not_found" };
  if (lead.stage === "lost") return { ok: false, error: "lead_lost" };
  const cycleRs = await db.execute({
    sql: "SELECT COALESCE(MAX(cycle_no), 0) AS n FROM ai_audit_engagements WHERE tenant_id = ? AND lead_id = ?",
    args: [tenantId, input.leadId],
  });
  const cycle = int(cycleRs.rows[0]?.n) + 1;
  const id = newId();
  const at = input.now.toISOString();
  const stage: AiAuditStage = lead.stage === "founder_meeting_booked" ? "call_scheduled" : "new_lead";
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO ai_audit_engagements (id, tenant_id, lead_id, cycle_no, stage, business_name, contact_name, contact_email,
                  is_fixture, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, tenantId, input.leadId, cycle, stage, lead.businessName, lead.contactName, lead.email, input.isFixture ? 1 : 0, input.actor.id, at, at],
        },
        eventStatement({ tenantId, engagementId: id, event: "opened", actor: input.actor, at, toStage: stage, meta: { cycle_no: cycle } }),
      ],
      "write",
    );
  } catch (err) {
    // A concurrent open won the one-open-per-lead index: hand back its row.
    const winner = await getOpenEngagementForLead(db, tenantId, input.leadId);
    if (winner) return { ok: true, engagement: winner, created: false };
    throw err;
  }
  const created = await getEngagement(db, tenantId, id);
  if (!created) throw new Error("ai-audit.store: opened an engagement but cannot read it back");
  return { ok: true, engagement: created, created: true };
}

// ---------------------------------------------------------------------------
// Compare-and-swap updates
// ---------------------------------------------------------------------------

/** Columns a caller may set through updateEngagement. Stage moves go through moveStage. */
const PATCHABLE = new Set([
  "health", "health_reason", "payment_status", "business_name", "business_type", "contact_name", "contact_email",
  "appointment_id", "meet_room_id", "engine", "current_profile_version_id", "current_audit_version_id",
  "current_proposal_version_id", "authorization_approval_id", "delivery_approval_id", "share_link_id",
  "customer_id", "delivery_project_id", "onboarding_status", "closed_at", "closed_reason",
  "call_started_at", "call_ended_at",
]);

export type EngagementPatch = Partial<Record<
  | "health" | "health_reason" | "payment_status" | "business_name" | "business_type" | "contact_name" | "contact_email"
  | "appointment_id" | "meet_room_id" | "engine" | "current_profile_version_id" | "current_audit_version_id"
  | "current_proposal_version_id" | "authorization_approval_id" | "delivery_approval_id" | "share_link_id"
  | "customer_id" | "delivery_project_id" | "onboarding_status" | "closed_at" | "closed_reason"
  | "call_started_at" | "call_ended_at",
  string | null
>>;

/**
 * The UPDATE for a patch (and optionally a stage), guarded on row_version.
 * Returned, not run: casWrite runs it first, and the rest only when it changed
 * exactly one row.
 */
/**
 * How long a delivery's `executing` mark holds changes off. Far longer than a
 * send takes; the mark of a run that crashed lapses after it (execute.ts never
 * re-runs an `executing` approval, so nothing is waiting on it).
 */
export const DELIVERY_IN_FLIGHT_MS = 15 * 60_000;

/**
 * SQL that is true while no final-approval email for this engagement is being
 * sent: no deliver_ai_audit approval for it is `executing` (claimed in the last
 * DELIVERY_IN_FLIGHT_MS). Placed inside the UPDATE of a change that would void
 * what the delivery checked (a transcript deleted, a stage moved, a reopen), it
 * makes the two take turns: if the change commits first, the delivery's checks
 * after its claim see it and send nothing; if the claim commits first, the
 * change is refused until the send is over (Codex review of phase 2, second pass).
 */
export function noDeliveryInFlight(tenantId: string, engagementId: string, now: Date): { sql: string; args: string[] } {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM approvals a WHERE a.tenant_id = ? AND a.action_kind = 'deliver_ai_audit' AND a.status = 'executing'
            AND a.executing_at > ? AND json_extract(a.payload_json, '$.engagement_id') = ?)`,
    args: [tenantId, new Date(now.getTime() - DELIVERY_IN_FLIGHT_MS).toISOString(), engagementId],
  };
}

/** Whether a final-approval email for this engagement is being sent right now (see noDeliveryInFlight). */
export async function deliveryInFlight(db: Client, tenantId: string, engagementId: string, now: Date): Promise<boolean> {
  const guard = noDeliveryInFlight(requireTenant(tenantId), engagementId, now);
  const rs = await db.execute({ sql: `SELECT ${guard.sql} AS clear`, args: guard.args });
  return Number(rs.rows[0]?.clear ?? 1) === 0;
}

export function engagementUpdateStatement(
  tenantId: string,
  id: string,
  expectedRowVersion: number,
  patch: EngagementPatch,
  at: string,
  stage?: AiAuditStage,
  /** Write only while the engagement is in one of these stages (a check that cannot go stale between read and write). */
  onlyInStages?: readonly AiAuditStage[],
  /** One more condition the write needs, checked inside it (noDeliveryInFlight). */
  guard?: { sql: string; args: Array<string | number> },
): InStatement {
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) throw new Error(`ai-audit.store: ${k} cannot be patched`);
    sets.push(`${k} = ?`);
    args.push(v ?? null);
  }
  if (stage) {
    sets.push("stage = ?");
    args.push(stage);
  }
  sets.push("row_version = row_version + 1", "updated_at = ?");
  args.push(at);
  const inStages = onlyInStages?.length ? ` AND stage IN (${onlyInStages.map(() => "?").join(", ")})` : "";
  const extra = guard ? ` AND ${guard.sql}` : "";
  return {
    sql: `UPDATE ai_audit_engagements SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ? AND row_version = ?${inStages}${extra}`,
    args: [...args, tenantId, id, expectedRowVersion, ...(onlyInStages ?? []), ...(guard?.args ?? [])],
  };
}

export type CasResult =
  | { ok: true; engagement: Engagement }
  | { ok: false; error: "conflict" | "not_found" | "move_not_allowed" | "delivery_in_progress"; engagement: Engagement | null };

/**
 * Patch an engagement (no stage change) with its event. `expectedRowVersion`
 * from the caller's read; a stale one answers conflict and writes nothing.
 */
export async function patchEngagement(
  db: Client,
  input: {
    tenantId: string;
    id: string;
    expectedRowVersion: number;
    patch: EngagementPatch;
    event: string;
    actor: Actor;
    now: Date;
    meta?: Record<string, unknown>;
    refType?: string;
    refId?: string;
    extra?: InStatement[];
    /** Write only while the engagement is in one of these stages, checked by the UPDATE itself. */
    onlyInStages?: readonly AiAuditStage[];
  },
): Promise<CasResult> {
  const tenantId = requireTenant(input.tenantId);
  const at = input.now.toISOString();
  const update = engagementUpdateStatement(tenantId, input.id, input.expectedRowVersion, input.patch, at, undefined, input.onlyInStages);
  const event = eventStatement({ tenantId, engagementId: input.id, event: input.event, actor: input.actor, at, meta: input.meta, refType: input.refType, refId: input.refId });
  const applied = await casWrite(db, update, [event, ...(input.extra ?? [])]);
  const after = await getEngagement(db, tenantId, input.id);
  if (!applied) return { ok: false, error: after ? "conflict" : "not_found", engagement: after };
  if (!after) return { ok: false, error: "not_found", engagement: null };
  return { ok: true, engagement: after };
}

/**
 * Move an engagement to another stage, if STAGE_MOVES allows it, with an
 * optional patch and extra statements in the same batch. The lead's pipeline
 * stage is moved afterwards by lifecycle.ts (it lives in another table with its
 * own idempotency, and the tick repairs any drift).
 */
export async function moveStage(
  db: Client,
  input: {
    tenantId: string;
    id: string;
    to: AiAuditStage;
    actor: Actor;
    now: Date;
    expectedRowVersion?: number;
    patch?: EngagementPatch;
    meta?: Record<string, unknown>;
    event?: string;
    extra?: InStatement[];
    /** Refuse while a final-approval email for this engagement is being sent (a move by hand). */
    unlessDeliveryInFlight?: boolean;
  },
): Promise<CasResult> {
  const tenantId = requireTenant(input.tenantId);
  const current = await getEngagement(db, tenantId, input.id);
  if (!current) return { ok: false, error: "not_found", engagement: null };
  if (input.expectedRowVersion !== undefined && current.row_version !== input.expectedRowVersion) {
    return { ok: false, error: "conflict", engagement: current };
  }
  if (current.stage === input.to) return { ok: true, engagement: current };
  if (!mayMoveStage(current.stage, input.to)) return { ok: false, error: "move_not_allowed", engagement: current };
  const at = input.now.toISOString();
  // Active Client ends the audit cycle too: the delivery project carries the client from here, and
  // the lead is free for other deals (an open engagement holds website sales off it, ownership.ts).
  const closing: EngagementPatch = input.to === "declined" || input.to === "cancelled" || input.to === "active_client" ? { closed_at: at, closed_reason: input.to } : {};
  const guard = input.unlessDeliveryInFlight ? noDeliveryInFlight(tenantId, current.id, input.now) : undefined;
  const update = engagementUpdateStatement(tenantId, current.id, current.row_version, { ...(input.patch ?? {}), ...closing }, at, input.to, undefined, guard);
  const ev = eventStatement({
    tenantId,
    engagementId: current.id,
    event: input.event ?? "stage_moved",
    actor: input.actor,
    at,
    fromStage: current.stage,
    toStage: input.to,
    meta: input.meta,
  });
  // A declined or cancelled engagement stops any profile draft still running, in the same write (review of phase 2b, F5).
  const stops = input.to === "declined" || input.to === "cancelled" ? stopEngagementRunsStatements(tenantId, current.id, "stage_closed", at) : [];
  const applied = await casWrite(db, update, [ev, ...stops, ...(input.extra ?? [])]);
  const after = await getEngagement(db, tenantId, current.id);
  if (!applied && after && guard && after.row_version === current.row_version && (await deliveryInFlight(db, tenantId, current.id, input.now))) {
    return { ok: false, error: "delivery_in_progress", engagement: after };
  }
  if (!applied) return { ok: false, error: after ? "conflict" : "not_found", engagement: after };
  if (!after) return { ok: false, error: "not_found", engagement: null };
  return { ok: true, engagement: after };
}

/** Record an event on its own (no state change): a view, a check, a note. */
export async function recordEvent(
  db: Client,
  input: { tenantId: string; engagementId: string; event: string; actor: Actor; now: Date; meta?: Record<string, unknown>; refType?: string; refId?: string },
): Promise<void> {
  await db.execute(
    eventStatement({
      tenantId: requireTenant(input.tenantId),
      engagementId: input.engagementId,
      event: input.event,
      actor: input.actor,
      at: input.now.toISOString(),
      meta: input.meta,
      refType: input.refType,
      refId: input.refId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type AiAuditSettings = {
  /** null until CC sets it; a proposal cannot be submitted without it. */
  tax: TaxRule | null;
  /** Default deposit in basis points, or null for full payment. */
  deposit_bps: number | null;
  default_currency: "CAD" | "USD";
  /** "mac_claude" (default) or "cloud_workspace" (phase 2). */
  engine: "mac_claude" | "cloud_workspace";
  /** The promise the handbook and email make, in CC's words. Empty until set. */
  turnaround: string;
};

export const DEFAULT_SETTINGS: AiAuditSettings = {
  tax: null,
  deposit_bps: null,
  default_currency: "CAD",
  engine: "mac_claude",
  turnaround: "",
};

export function parseSettings(raw: Record<string, unknown>): AiAuditSettings {
  const tax = raw.tax ? validateTaxRule(raw.tax) : null;
  const bps = Number(raw.deposit_bps);
  return {
    tax: tax && tax.ok ? tax.value : null,
    deposit_bps: Number.isInteger(bps) && bps >= 1_000 && bps <= 9_000 ? bps : null,
    default_currency: raw.default_currency === "USD" ? "USD" : "CAD",
    engine: raw.engine === "cloud_workspace" ? "cloud_workspace" : "mac_claude",
    turnaround: typeof raw.turnaround === "string" ? raw.turnaround.trim().slice(0, 200) : "",
  };
}

export async function getSettings(db: Client, tenantId: string): Promise<{ settings: AiAuditSettings; rowVersion: number }> {
  const rs = await db.execute({
    sql: "SELECT settings, row_version FROM ai_audit_settings WHERE tenant_id = ? LIMIT 1",
    args: [requireTenant(tenantId)],
  });
  const row = rs.rows[0];
  if (!row) return { settings: { ...DEFAULT_SETTINGS }, rowVersion: 0 };
  return { settings: parseSettings(parseObject(row.settings)), rowVersion: int(row.row_version, 1) };
}

export async function saveSettings(
  db: Client,
  input: { tenantId: string; settings: AiAuditSettings; expectedRowVersion: number; actorId: string | null; now: Date },
): Promise<{ ok: true } | { ok: false; error: "conflict" }> {
  const tenantId = requireTenant(input.tenantId);
  const at = input.now.toISOString();
  const json = JSON.stringify(input.settings);
  if (input.expectedRowVersion === 0) {
    const rs = await db.execute({
      sql: `INSERT INTO ai_audit_settings (tenant_id, settings, row_version, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)
            ON CONFLICT (tenant_id) DO NOTHING`,
      args: [tenantId, json, input.actorId, at],
    });
    return rs.rowsAffected === 1 ? { ok: true } : { ok: false, error: "conflict" };
  }
  const rs = await db.execute({
    sql: `UPDATE ai_audit_settings SET settings = ?, row_version = row_version + 1, updated_by = ?, updated_at = ?
          WHERE tenant_id = ? AND row_version = ?`,
    args: [json, input.actorId, at, tenantId, input.expectedRowVersion],
  });
  return rs.rowsAffected === 1 ? { ok: true } : { ok: false, error: "conflict" };
}

/** True when the ai_audit tables exist (the migration has been applied). */
export async function aiAuditTablesInstalled(db: Client): Promise<boolean> {
  // bravo__237, 238 and 239 must all be in: this code reads 239's two tables
  // and the two columns it adds to the engagement (review of phase 2, F6). A
  // column added by ALTER TABLE shows in the table's stored CREATE statement.
  // 241 (the pre-call brief) is not checked here: the brief checks its own
  // tables (lib/ai-audit/briefs.ts briefTablesInstalled), so the rest of the
  // audit keeps running if code reaches a database before that migration.
  const rs = await db.execute({
    sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('ai_audit_engagements', 'ai_audit_share_links', 'ai_audit_transcripts', 'ai_audit_call_notes')",
    args: [],
  });
  if (rs.rows.length !== 4) return false;
  const engagements = String(rs.rows.find((r) => String(r.name) === "ai_audit_engagements")?.sql ?? "");
  return /\bcall_started_at\b/.test(engagements) && /\bcall_ended_at\b/.test(engagements);
}
