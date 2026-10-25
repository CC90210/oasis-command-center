/**
 * lib/ai-audit/lifecycle.ts — moving an engagement, and its lead, through the
 * CRM stages.
 *
 * The engagement's stage changes first (store.moveStage: compare-and-swap,
 * audit-trail event in the same transaction). The lead's pipeline stage then
 * follows, FORWARD ONLY, through transition_pipeline_lead (lib/turso-rpc-shim:
 * the same expected-stage check and request-id idempotency the website-sales
 * engine uses). A lead the team already moved further is never pulled back,
 * and a lost lead is never revived by an audit. If the lead move fails, the
 * engagement still moved; the tick repairs the lead on its next run
 * (repairLeadStage). Moving a lead stage sends nothing to the client.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { transition_pipeline_lead } from "@/lib/turso-rpc-shim";
import { LEAD_STAGE_FOR, TERMINAL_STAGES, type AiAuditStage } from "@/lib/ai-audit/rules";
import { moveStage, readLead, type Actor, type CasResult, type Engagement, type EngagementPatch } from "@/lib/ai-audit/store";

/** The pipeline order, without the lost branch (lib/oasis-stage-meta.ts). */
export const LEAD_ORDER = [
  "researched",
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
  "in_build",
  "client_review",
  "launched",
] as const;

const PRE_WON = new Set<string>(LEAD_ORDER.slice(0, LEAD_ORDER.indexOf("won")));

export type LeadMove = { moved: boolean; from: string; to: string; reason?: string };

/**
 * Move the lead to `target` if that is forward of where it is. The request id
 * makes a retry a no-op (transition_pipeline_lead answers idempotent).
 */
export async function moveLeadForward(
  db: Client,
  input: { tenantId: string; leadId: string; target: string; requestId: string; actorUserId: string; note: string; now: Date },
): Promise<LeadMove> {
  const lead = await readLead(db, input.tenantId, input.leadId);
  if (!lead) return { moved: false, from: "", to: input.target, reason: "lead_not_found" };
  const from = lead.stage;
  if (from === input.target) return { moved: false, from, to: input.target, reason: "already_there" };
  if (from === "lost") return { moved: false, from, to: input.target, reason: "lead_is_lost" };
  if (input.target === "lost") {
    if (!PRE_WON.has(from)) return { moved: false, from, to: input.target, reason: "lead_past_sale" };
  } else {
    const at = LEAD_ORDER.indexOf(from as (typeof LEAD_ORDER)[number]);
    const to = LEAD_ORDER.indexOf(input.target as (typeof LEAD_ORDER)[number]);
    if (to < 0) return { moved: false, from, to: input.target, reason: "unknown_target" };
    if (at >= to) return { moved: false, from, to: input.target, reason: "lead_already_further" };
  }
  const patch: Record<string, unknown> = { stage: input.target };
  if (input.target === "lost") patch.loss_reason = "ai_audit_declined";
  const result = (await transition_pipeline_lead(db, {
    p_tenant_id: input.tenantId,
    p_lead_id: input.leadId,
    p_expected_stage: from,
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
    p_action: "ai_audit_stage",
    p_interaction_type: "stage_changed",
    p_subject: "AI audit stage",
    p_content: input.note.slice(0, 2_000) || `AI audit moved the lead from ${from || "none"} to ${input.target}.`,
    p_patch: patch,
    p_occurred_at: input.now.toISOString(),
    p_channel: "system",
    p_direction: "internal",
    p_metadata: { program: "ai_audit" },
  })) as { ok?: boolean; error?: string } | null;
  if (result && result.ok) return { moved: true, from, to: input.target };
  return { moved: false, from, to: input.target, reason: result?.error ?? "transition_failed" };
}

/** The request id one engagement edge always uses, so a retry is recognised. */
export function leadRequestId(engagement: Pick<Engagement, "id">, stage: AiAuditStage): string {
  return `ai-audit:${engagement.id}:${stage}`;
}

/**
 * Move the engagement, then the lead. The result is the engagement move's; the
 * lead move is best-effort and reported, and the tick repairs it later.
 */
export async function advanceEngagement(
  db: Client,
  input: {
    tenantId: string;
    engagementId: string;
    to: AiAuditStage;
    actor: Actor;
    now: Date;
    expectedRowVersion?: number;
    patch?: EngagementPatch;
    meta?: Record<string, unknown>;
    event?: string;
  },
): Promise<CasResult & { lead?: LeadMove }> {
  const { engagementId, ...rest } = input;
  const moved = await moveStage(db, { ...rest, id: engagementId });
  if (!moved.ok) return moved;
  const lead = await syncLeadStage(db, moved.engagement, input.actor, input.now);
  return { ...moved, lead };
}

/** Bring the lead up to the stage its engagement implies. Safe to call any time. */
export async function syncLeadStage(db: Client, engagement: Engagement, actor: Actor, now: Date): Promise<LeadMove | undefined> {
  const target = LEAD_STAGE_FOR[engagement.stage];
  if (!target) return undefined;
  if (TERMINAL_STAGES.includes(engagement.stage) && engagement.stage !== "declined") return undefined;
  try {
    return await moveLeadForward(db, {
      tenantId: engagement.tenant_id,
      leadId: engagement.lead_id,
      target,
      requestId: leadRequestId(engagement, engagement.stage),
      actorUserId: actor.id ?? "system:ai-audit",
      note: `AI audit: ${engagement.stage.replace(/_/g, " ")}.`,
      now,
    });
  } catch (err) {
    console.error("[ai-audit.lifecycle] lead stage move failed; the tick will retry", {
      engagementId: engagement.id,
      target,
      error: err instanceof Error ? err.message : String(err),
    });
    return { moved: false, from: "", to: target, reason: "error" };
  }
}
