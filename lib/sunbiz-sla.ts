/**
 * lib/sunbiz-sla.ts — per-stage SLA windows + helpers for the
 * SunBiz pipeline view.
 *
 * The SLA defines "how long can a lead sit in this stage before it
 * counts as overdue". The pipeline view uses it for:
 *   1. Per-row "going cold" red-text on the LAST TOUCH column.
 *   2. Counter strip "{N} going cold" calculation.
 *
 * UI labels are intentionally narrower than this map: terminal,
 * archival, and lender-lifecycle stages can have backend windows that
 * should not be shown as operator-facing "SLA 30D" noise.
 *
 * Tunable later via a manifest entry per tenant. v1 values from CC's
 * mockup + SunBiz Adon-team standard cadence.
 */

export const STAGE_SLA_DAYS: Record<string, number> = {
  // Lead stages (migration 064 — imported / not_interested / approved
  // retired). Terminal stages keep 999d so they never count as overdue.
  hot_lead: 1,
  missing_info: 3,
  declined: 999,
  follow_up: 2,
  sent_application: 5,
  viewed_application: 2,
  signed_application: 2,
  default: 7,
  submitted: 5,
  // Opportunity stages — 2026-05-28 v3 (Adon's 7-stage spec, migration
  // 065+066). Keys are Adon's canonical labels (Title Case) since they
  // come from the merchant_summary view directly.
  "Application In": 1,
  "Missing Info":   2,
  "Shopping":       3,
  "Approved":       2, // operator decision window — push for funding paperwork
  "Declined":       999,
  "Funded":         999,
  "Dead":           999,
  // Legacy keys retained for any code path still reading data.stage
  // (the unfiltered raw value). These will drop after Phase 5 deletes
  // the legacy variant.
  application_in: 1,
  shopping: 3,
  requested_docs: 2,
  docs_out: 2,
  login: 1,
  funded: 999,
  follow_ups: 3,
  dead_file: 999,
};

/** Stages an "active" lead can be in. Excludes terminal stages
 *  (Declined, Funded, Dead). Mixed-case keys are Adon's 7-stage labels
 *  used by merchant_summary.deal_stage; snake_case keys are legacy
 *  data.stage values (retained until Phase 5 retires the old variant). */
export const ACTIVE_STAGES = new Set<string>([
  // Lead-side active
  "hot_lead",
  "missing_info",
  "follow_up",
  "sent_application",
  "viewed_application",
  "signed_application",
  "submitted",
  // Application-side active — Adon 7-stage
  "Application In",
  "Missing Info",
  "Shopping",
  "Approved",
  // Legacy 10-stage
  "application_in",
  "shopping",
  "requested_docs",
  "docs_out",
  "login",
  "follow_ups",
]);

export const VISIBLE_TARGET_STAGES = new Set<string>([
  // Lead-side
  "hot_lead",
  "missing_info",
  "follow_up",
  "sent_application",
  "viewed_application",
  "signed_application",
  "submitted",
  // Application-side — Adon 7-stage
  "Application In",
  "Missing Info",
  "Shopping",
  "Approved",
  // Legacy 10-stage
  "application_in",
  "shopping",
  "requested_docs",
  "docs_out",
  "login",
  "follow_ups",
]);

/** Stages where the operator should be advancing the deal NOW. */
export const READY_TO_ADVANCE_STAGES = new Set<string>([
  "viewed_application",
  "signed_application",
  // Adon 7-stage
  "Application In",
  "Approved",
  // Legacy 10-stage
  "application_in",
  "docs_out",
  "login",
]);

export function slaDaysFor(stage: string): number {
  return STAGE_SLA_DAYS[stage] ?? 7;
}

export function stageTargetLabel(stage: string): string | null {
  if (!VISIBLE_TARGET_STAGES.has(stage)) return null;
  const days = slaDaysFor(stage);
  if (!Number.isFinite(days) || days >= 999) return null;
  return `${days}d target`;
}

export function daysSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

/**
 * "Going cold" predicate — lead is in an active stage AND last_touch
 * is older than the SLA. Used by counter + per-row red-text styling.
 */
export function isGoingCold(stage: string, lastTouchIso: string | null | undefined): boolean {
  if (!ACTIVE_STAGES.has(stage)) return false;
  return daysSince(lastTouchIso) > slaDaysFor(stage);
}
