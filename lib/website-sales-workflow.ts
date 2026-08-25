import { roleMayOperateOasisSalesLead } from "@/lib/oasis-sales-pipeline-policy";

export const OASIS_WEBSITE_TENANT_SLUG = "oasis-webdev";

export type RepDisposition = "attempted" | "voicemail" | "connected" | "lost";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Role floor for changing the OASIS sales lifecycle. Ownership is checked
 * separately by the route; this prevents an assigned read-only, marketing, or
 * delivery account from turning record visibility into sales-write authority.
 */
export function mayWorkWebsiteSalesLifecycle(
  teamRole: string | null | undefined,
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  return roleMayOperateOasisSalesLead(teamRole);
}

export type WebsiteSalesCloseParties = {
  closerUserId: string;
  openerUserId: string | null;
  closedByRep: boolean;
};

const ADMIN_VERIFIED_CLOSER_ROLES = new Set(["agent", "closer", "manager"]);

/**
 * A founder clicking "payment verified" is not evidence that the founder ran
 * the close. Credit a different closer only when tenant-scoped profile data
 * still says they are close-capable and the lead identifies them as either the
 * booked audit host or the current assigned closer.
 */
export function mayCreditAdminVerifiedCloser(input: {
  candidateUserId: unknown;
  frozenOpenerUserId: unknown;
  auditHostUserId: unknown;
  assignedTo: unknown;
  recordedAuditHostRole: unknown;
  liveTeamRole: unknown;
  isOwner: unknown;
}): boolean {
  const normalizeUserId = (value: unknown) =>
    typeof value === "string" && USER_ID.test(value.trim()) ? value.trim().toLowerCase() : "";
  const candidate = normalizeUserId(input.candidateUserId);
  const frozenOpener = normalizeUserId(input.frozenOpenerUserId);
  if (!candidate || candidate === frozenOpener || input.isOwner === true || input.isOwner === 1) return false;
  const liveRole = typeof input.liveTeamRole === "string" ? input.liveTeamRole.trim().toLowerCase() : "";
  if (!ADMIN_VERIFIED_CLOSER_ROLES.has(liveRole)) return false;

  const auditHost = normalizeUserId(input.auditHostUserId);
  const assigned = normalizeUserId(input.assignedTo);
  const recordedAuditHostRole =
    typeof input.recordedAuditHostRole === "string" ? input.recordedAuditHostRole.trim().toLowerCase() : "";
  return candidate === assigned || (
    candidate === auditHost && ADMIN_VERIFIED_CLOSER_ROLES.has(recordedAuditHostRole)
  );
}

/** Freeze handoff credit to the existing opener, then the assigned rep, and
 * only finally the actor. This keeps an admin-assisted booking from claiming
 * attribution that belongs to the rep already working the lead. */
export function resolveWebsiteSalesHandoffRep(
  attributedRepUserId: unknown,
  assignedTo: unknown,
  actorUserId: string,
): string {
  for (const candidate of [attributedRepUserId, assignedTo]) {
    if (typeof candidate === "string" && USER_ID.test(candidate.trim())) {
      return candidate.trim().toLowerCase();
    }
  }
  return actorUserId.trim().toLowerCase();
}

/**
 * Resolve the people attached to a close without collapsing a two-person sale
 * into the frozen opener. `attributed_rep_user_id` is the opener after handoff;
 * `assigned_to` is the closer currently working the deal. A non-admin caller
 * can only close when they are one of those two people. An admin verifier may
 * supply a separately validated closer; otherwise the close is founder-run and
 * pays only the frozen opener.
 */
export function resolveWebsiteSalesCloseParties(input: {
  assignedTo: unknown;
  attributedRepUserId: unknown;
  actorUserId: string;
  isTrueAdmin: boolean;
  trustedCloserUserId?: unknown;
}): WebsiteSalesCloseParties | null {
  const actor = input.actorUserId.trim().toLowerCase();
  const assigned = typeof input.assignedTo === "string" ? input.assignedTo.trim().toLowerCase() : "";
  const attributed =
    typeof input.attributedRepUserId === "string"
      ? input.attributedRepUserId.trim().toLowerCase()
      : "";
  const trustedCloser =
    typeof input.trustedCloserUserId === "string" && USER_ID.test(input.trustedCloserUserId.trim())
      ? input.trustedCloserUserId.trim().toLowerCase()
      : "";

  if (input.isTrueAdmin) {
    if (trustedCloser && trustedCloser !== attributed) {
      return {
        closerUserId: trustedCloser,
        openerUserId: attributed || (assigned !== trustedCloser ? assigned || null : null),
        closedByRep: true,
      };
    }
    // When a founder actually closes, the paid sales party is the opener.
    // Frozen attribution is the strongest opener fact; assignment is the
    // legacy fallback. Treating that rep as a full-stack closer would overpay
    // the common "rep books, founder closes" path at 40% instead of 20%.
    const openerUserId = attributed || assigned;
    if (!openerUserId) return null;
    return {
      // The RPC's primary rep parameter is named closer for legacy reasons;
      // p_closed_by_rep=false makes this party an opener in the v3 engine.
      closerUserId: openerUserId,
      openerUserId: null,
      closedByRep: false,
    };
  }

  if (!actor || (actor !== assigned && actor !== attributed)) return null;
  return {
    closerUserId: actor,
    openerUserId: attributed && attributed !== actor ? attributed : null,
    closedByRep: true,
  };
}

/**
 * The normal forward edge from each OASIS stage. Lost and launched are
 * terminal; researched enters the working pipeline through assignment/claim,
 * not through the lead-file action panel.
 *
 * This is intentionally a map instead of an array-index lookup. Won branches
 * into delivery while lost branches out of the lifecycle entirely, and making
 * those edges explicit prevents a reordered display list from silently
 * changing business behavior.
 */
const NEXT_OASIS_LIFECYCLE_STAGE: Readonly<Record<string, string>> = {
  assigned: "attempting_contact",
  attempting_contact: "connected",
  connected: "qualified",
  qualified: "founder_meeting_booked",
  founder_meeting_booked: "demo_completed",
  demo_completed: "proposal_sent",
  proposal_sent: "won",
  won: "onboarding",
  onboarding: "in_build",
  in_build: "client_review",
  client_review: "launched",
};

export function nextOasisLifecycleStage(stage: unknown): string | null {
  return typeof stage === "string" ? NEXT_OASIS_LIFECYCLE_STAGE[stage] ?? null : null;
}

const ADMIN_DIRECT_ADVANCE_STAGES = new Set([
  "assigned",
  "won",
  "onboarding",
  "in_build",
  "client_review",
]);

/**
 * Direct advance is reserved for edges that need no extra business data.
 * Calls, qualification, proposals, and closes have structured actions so a
 * stage button can never skip the facts, pricing, or payment record they need.
 */
export function mayUseDirectAdvance(
  stage: unknown,
  isAdmin: boolean,
  _mayRunDeal = false,
): boolean {
  if (stage === "assigned") return true;
  return isAdmin && typeof stage === "string" && ADMIN_DIRECT_ADVANCE_STAGES.has(stage);
}

export function maySendWebsiteProposal(stage: unknown): boolean {
  return stage === "demo_completed";
}

export function mayCloseWebsiteDeal(stage: unknown): boolean {
  return stage === "proposal_sent";
}

export function mayAgentQualify(stage: unknown): boolean {
  return stage === "connected";
}

/**
 * A rep may always book from the explicit Qualified stage. The lead profile
 * also supports the real-world "the prospect agreed to the audit on this
 * call" path: a pre-Founder stage may book only when the same request carries
 * every qualification gate. The API still validates and persists those facts
 * before it uses this predicate.
 */
export function mayAgentBookFounder(
  stage: unknown,
  qualificationIncluded = false,
): boolean {
  if (stage === "qualified") return true;
  return qualificationIncluded && ["assigned", "attempting_contact", "connected"].includes(String(stage));
}

export function mayRecordDisposition(stage: unknown, disposition: RepDisposition): boolean {
  if (typeof stage !== "string") return false;
  if (disposition === "lost") {
    return ["assigned", "attempting_contact", "connected", "qualified"].includes(stage);
  }
  if (disposition === "connected") {
    return ["assigned", "attempting_contact", "connected"].includes(stage);
  }
  return stage === "assigned" || stage === "attempting_contact";
}

export function dispositionPatch(
  disposition: RepDisposition,
  nextActionAt: string | null,
  occurredAt = new Date().toISOString(),
  lossReason = "",
): Record<string, unknown> {
  if ((disposition === "attempted" || disposition === "voicemail") && !nextActionAt) {
    throw new Error("next_action_required");
  }
  if (nextActionAt && (!Number.isFinite(Date.parse(nextActionAt)) || Date.parse(nextActionAt) <= Date.parse(occurredAt))) {
    throw new Error("next_action_must_be_in_future");
  }
  const cleanLossReason = lossReason.trim();
  if (disposition === "lost" && !cleanLossReason) throw new Error("loss_reason_required");
  if (cleanLossReason.length > 500) throw new Error("loss_reason_too_long");
  const stage = disposition === "connected"
    ? "connected"
    : disposition === "lost"
      ? "lost"
      : "attempting_contact";
  return {
    stage,
    last_disposition: disposition,
    last_contact_at: occurredAt,
    // Supabase migration 074 mirrors interaction rows into this field, but
    // Turso has no Postgres trigger. Persist it with the lifecycle write so
    // /pipeline and /today agree with the interaction ledger on both backends.
    last_contacted_at: occurredAt,
    // Claim expiry keys off the last real dial, not a generic record update.
    // Every disposition represents an attempted call, including a loss.
    last_call_at: occurredAt,
    next_action_at: nextActionAt,
    ...(disposition === "lost" ? { loss_reason: cleanLossReason } : {}),
  };
}
