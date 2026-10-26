/**
 * lib/ai-audit/rules.ts — the Free AI Audit's vocabulary, in one place.
 *
 * PURE: no I/O, no server-only import, so the board, the editors and the
 * server share one definition of every stage, label and allowed move.
 *
 * THE 13 CRM STAGES are CC's brief (2026-10-25, section 9) word for word, plus
 * the two end states it asks for (declined, cancelled). "Stalled" and
 * "payment failed" are FLAGS (engagement.health / payment_status), not stages:
 * the stage stays where the work stopped, so the board says both where a
 * prospect is and what went wrong there.
 *
 * Each stage moves the lead's existing pipeline stage too (LEAD_STAGE_FOR), so
 * every report, board and SLA that reads tenant_records keeps working.
 */

export const AI_AUDIT_STAGES = [
  "new_lead",
  "pre_call_research",
  "call_scheduled",
  "call_completed",
  "transcript_review",
  "generating",
  "final_review",
  "delivered",
  "proposal_review",
  "payment_pending",
  "payment_confirmed",
  "onboarding",
  "active_client",
  "declined",
  "cancelled",
] as const;
export type AiAuditStage = (typeof AI_AUDIT_STAGES)[number];

export const AI_AUDIT_STAGE_LABELS: Readonly<Record<AiAuditStage, string>> = {
  new_lead: "New Lead",
  pre_call_research: "Research in Progress",
  call_scheduled: "Discovery Call Scheduled",
  call_completed: "Discovery Call Completed",
  transcript_review: "Transcript Awaiting Approval",
  generating: "Research & Audit Generation",
  final_review: "Audit Awaiting Final Approval",
  delivered: "Audit Delivered",
  proposal_review: "Proposal Under Review",
  payment_pending: "Payment Pending",
  payment_confirmed: "Payment Confirmed",
  onboarding: "Onboarding In Progress",
  active_client: "Active Client",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** The brief's numbering (1-13). The end states have no number. */
export function stageNumber(stage: AiAuditStage): number | null {
  const i = AI_AUDIT_STAGES.indexOf(stage);
  return i >= 0 && i < 13 ? i + 1 : null;
}

export const TERMINAL_STAGES: readonly AiAuditStage[] = ["declined", "cancelled"];

/**
 * The lead pipeline stage each engagement stage implies (lib/oasis-stage-meta.ts).
 * null: leave the lead where it is. The lead only ever moves FORWARD
 * (lifecycle.ts moveLeadForward), so a lead the team already moved further is
 * never pulled back.
 */
export const LEAD_STAGE_FOR: Readonly<Record<AiAuditStage, string | null>> = {
  new_lead: null,
  pre_call_research: null,
  call_scheduled: "founder_meeting_booked",
  call_completed: "demo_completed",
  transcript_review: "demo_completed",
  generating: "demo_completed",
  final_review: "demo_completed",
  delivered: "proposal_sent",
  proposal_review: "proposal_sent",
  payment_pending: "proposal_sent",
  payment_confirmed: "won",
  onboarding: "onboarding",
  active_client: "in_build",
  declined: "lost",
  cancelled: null,
};

/**
 * Every move a stage may make. A move not listed here is refused, whoever asks.
 * The automation (tick, executors, payment verification) and the owner's
 * buttons go through the same table.
 */
export const STAGE_MOVES: Readonly<Record<AiAuditStage, readonly AiAuditStage[]>> = {
  new_lead: ["pre_call_research", "call_scheduled", "call_completed", "declined", "cancelled"],
  pre_call_research: ["call_scheduled", "call_completed", "declined", "cancelled"],
  call_scheduled: ["call_completed", "pre_call_research", "declined", "cancelled"],
  call_completed: ["transcript_review", "declined", "cancelled"],
  // Phase 2: Transcript Awaiting Approval moves on ONLY through Gate 1 (the
  // authorize_ai_audit executor), to generating, even when CC writes the audit
  // himself. Back to Discovery Call Completed reopens the call's capture.
  transcript_review: ["generating", "call_completed", "declined", "cancelled"],
  generating: ["final_review", "transcript_review", "declined", "cancelled"],
  // Out of final review only by delivery, Reopen (to generating, which withdraws
  // the frozen versions and opens drafts), decline or cancel. A bare move back
  // left the versions frozen and every editor locked (Codex review of PR #732).
  final_review: ["delivered", "generating", "declined", "cancelled"],
  // Back to generating only through a revision after delivery (lib/ai-audit/delivery.ts reviseAfterDelivery, phase 5):
  // it closes the payment pages and opens drafts copied from what the client has; never a move by hand.
  delivered: ["proposal_review", "payment_pending", "payment_confirmed", "final_review", "generating", "declined", "cancelled"],
  proposal_review: ["payment_pending", "payment_confirmed", "final_review", "generating", "declined", "cancelled"],
  payment_pending: ["payment_confirmed", "proposal_review", "final_review", "generating", "declined", "cancelled"],
  payment_confirmed: ["onboarding"],
  onboarding: ["active_client"],
  active_client: [],
  declined: [],
  cancelled: [],
};

export function mayMoveStage(from: AiAuditStage, to: AiAuditStage): boolean {
  return STAGE_MOVES[from].includes(to);
}

/** The stages the owner may set by hand (the rest are set by the work itself). */
export const MANUAL_STAGE_TARGETS: readonly AiAuditStage[] = [
  "pre_call_research",
  "call_scheduled",
  "call_completed",
  "transcript_review",
  "declined",
  "cancelled",
];

export const HEALTH_FLAGS = ["ok", "stalled", "failed", "attention"] as const;
export type HealthFlag = (typeof HEALTH_FLAGS)[number];

export const PAYMENT_STATUSES = [
  "none",
  "pending",
  "failed",
  "paid",
  "overpaid_review",
  "partially_refunded",
  "refunded",
  "disputed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ONBOARDING_STATUSES = ["not_started", "in_progress", "done", "blocked"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

// ---------------------------------------------------------------------------
// Evidence labels (brief section 5)
// ---------------------------------------------------------------------------

/**
 * The warnings that say an earlier Gate 1 no longer holds. A new authorization
 * clears these, and only these (Codex review of phase 2, fourth pass).
 */
export const AUTHORIZATION_VOIDED_REASONS = {
  transcriptDeleted: "A transcript the authorization covered was deleted, so the authorization no longer holds. Move the engagement back to Transcript Awaiting Approval and authorize again.",
  notAuthorized:
    "The client's information is no longer authorized (Gate 1), for example because a transcript it covered was deleted. Move the engagement back to Transcript Awaiting Approval, authorize it again, then submit again.",
} as const;

export const EVIDENCE_LABELS = ["verified", "client_reported", "estimate", "hypothesis"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export const EVIDENCE_LABEL_NAMES: Readonly<Record<EvidenceLabel, string>> = {
  verified: "Verified fact",
  client_reported: "Client-reported",
  estimate: "Reasonable estimate",
  hypothesis: "Hypothesis",
};

/** What each label promises, as the client's page explains it. */
export const EVIDENCE_LABEL_MEANINGS: Readonly<Record<EvidenceLabel, string>> = {
  verified: "Backed by a source we can point to, a check we ran ourselves, or something you confirmed with evidence.",
  client_reported: "Something you told us on our call. We have not checked it independently.",
  estimate: "A calculation, shown with its inputs and assumptions. A range, never a promise.",
  hypothesis: "A likely problem or opportunity that still needs checking. We say how it could be tested.",
};

// ---------------------------------------------------------------------------
// Business types (brief section 5: the audit adapts to the business)
// ---------------------------------------------------------------------------

export const BUSINESS_TYPES = [
  "local_service",
  "ecommerce",
  "professional_services",
  "individual_productivity",
  "other",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Readonly<Record<BusinessType, string>> = {
  local_service: "Local service business",
  ecommerce: "E-commerce",
  professional_services: "Professional services",
  individual_productivity: "Individual productivity",
  other: "Other",
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export const CURRENCIES = ["CAD", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CATALOGUE_CATEGORIES = ["implementation", "monthly", "add_on", "website"] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];

export const CATALOGUE_UNITS = ["fixed", "per_unit", "per_month"] as const;
export type CatalogueUnit = (typeof CATALOGUE_UNITS)[number];

export const CATALOGUE_STATUSES = ["proposed", "confirmed", "retired"] as const;
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];

export const VERSION_STATUSES = ["draft", "awaiting_approval", "approved", "delivered", "superseded", "withdrawn"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const INSTALLMENT_KINDS = ["full", "deposit", "balance"] as const;
export type InstallmentKind = (typeof INSTALLMENT_KINDS)[number];

/** How long a client's private link works. CC can revoke it sooner. */
export const SHARE_LINK_TTL_DAYS = 30;
/** Stripe Checkout Sessions expire after 24 hours; ours is created when the client presses Pay. */
export const CHECKOUT_TTL_HOURS = 24;

// ---------------------------------------------------------------------------
// Stall rules (plan section 12)
// ---------------------------------------------------------------------------

export const STALL_NO_VIEW_DAYS = 3;
export const STALL_NO_PAYMENT_DAYS = 7;
const DAY_MS = 86_400_000;

/** The stages where the next move is the client's. */
export const WAITING_ON_CLIENT_STAGES: readonly AiAuditStage[] = ["delivered", "proposal_review", "payment_pending"];

/**
 * Why an engagement that waits on the client is stalled, or null.
 *
 * Never opened: counted from delivery. Opened but unpaid: counted from the
 * first view. A client who pressed Pay and walked away is still unpaid: their
 * Checkout Session expires after a day, the stage stays Payment Pending and the
 * payment status stays pending, so this rule must cover them too (Codex review
 * of PR #732: they were excluded and never alerted).
 */
export function stallReason(
  e: { stage: AiAuditStage; payment_status: PaymentStatus },
  link: { created_at: string; first_viewed_at: string | null },
  now: Date,
): string | null {
  if (!WAITING_ON_CLIENT_STAGES.includes(e.stage)) return null;
  if (e.payment_status !== "none" && e.payment_status !== "pending") return null;
  const t = now.getTime();
  if (e.stage === "payment_pending") {
    const since = Date.parse(link.first_viewed_at ?? link.created_at);
    return t - since > STALL_NO_PAYMENT_DAYS * DAY_MS ? `Started checkout, but no payment ${STALL_NO_PAYMENT_DAYS} days after opening the audit.` : null;
  }
  if (!link.first_viewed_at) {
    return t - Date.parse(link.created_at) > STALL_NO_VIEW_DAYS * DAY_MS ? `Not opened ${STALL_NO_VIEW_DAYS} days after delivery.` : null;
  }
  return t - Date.parse(link.first_viewed_at) > STALL_NO_PAYMENT_DAYS * DAY_MS ? `Opened, but no payment ${STALL_NO_PAYMENT_DAYS} days later.` : null;
}

/** Stages where the discovery profile and transcripts may still change: before Gate 1. */
export const PROFILE_EDIT_STAGES: readonly AiAuditStage[] = ["new_lead", "pre_call_research", "call_scheduled", "call_completed", "transcript_review"];

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

export function isAiAuditStage(v: unknown): v is AiAuditStage {
  return isOneOf(AI_AUDIT_STAGES, v);
}

/**
 * The next thing someone has to do, in plain words, for the board's "Next"
 * column. Health flags speak first: a stalled or failed engagement says what
 * is wrong before it says what is next.
 */
export function nextActionFor(e: {
  stage: AiAuditStage;
  health: HealthFlag;
  health_reason: string | null;
  payment_status: PaymentStatus;
  onboarding_status: OnboardingStatus;
}): string {
  if (e.health === "failed") return `Fix: ${e.health_reason || "a step failed"}`;
  if (e.health === "attention") return `Check: ${e.health_reason || "needs a decision"}`;
  if (e.payment_status === "disputed") return "Respond to the payment dispute";
  if (e.payment_status === "refunded" || e.payment_status === "partially_refunded") return "Review the refund";
  if (e.payment_status === "overpaid_review") return "Review a second payment";
  switch (e.stage) {
    case "new_lead":
      return "Prepare for the discovery call";
    case "pre_call_research":
      return "Book the discovery call";
    case "call_scheduled":
      return "Run the discovery call";
    case "call_completed":
      return "Add the transcript, check the profile, then ask for authorization";
    case "transcript_review":
      return "Approve the authorization in Needs you (Gate 1)";
    case "generating":
      return "Write the audit and the proposal";
    case "final_review":
      return "Review and approve the audit";
    case "delivered":
      return e.health === "stalled" ? "Follow up: not opened yet" : "Waiting for the client to open it";
    case "proposal_review":
      return e.health === "stalled" ? "Follow up: opened, not paid" : "Waiting for the client's decision";
    case "payment_pending":
      return e.payment_status === "failed" ? "Payment failed: follow up" : "Waiting for Stripe to confirm";
    case "payment_confirmed":
      return "Onboarding is starting";
    case "onboarding":
      return e.onboarding_status === "blocked" ? "Onboarding is blocked" : "Finish the onboarding checklist";
    case "active_client":
      return "Deliver the project";
    case "declined":
    case "cancelled":
      return "Closed";
  }
}

/**
 * A business's name for a title: approvals and alerts cap their titles, and a
 * name may be 200 characters (review of phase 2: a long name made Gate 1 fail
 * with title_too_long).
 */
export function shortName(name: string | null | undefined, fallback: string, max = 80): string {
  const n = (name ?? "").trim();
  if (!n) return fallback;
  return n.length > max ? `${n.slice(0, max - 3).trimEnd()}...` : n;
}

/** A business name as an email to the client says it: on one line, and short enough for any subject line. */
export function oneLineName(name: string | null | undefined, fallback: string, max = 80): string {
  return shortName((name ?? "").replace(/\s+/g, " "), fallback, max);
}
