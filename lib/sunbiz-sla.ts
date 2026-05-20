/**
 * lib/sunbiz-sla.ts — per-stage SLA windows + helpers for the
 * SunBiz pipeline view.
 *
 * The SLA defines "how long can a lead sit in this stage before it
 * counts as overdue". The pipeline view uses it three ways:
 *   1. Section-header "SLA 2D" badge per stage.
 *   2. Per-row "going cold" red-text on the LAST TOUCH column.
 *   3. Counter strip "{N} going cold" calculation.
 *
 * Tunable later via a manifest entry per tenant. v1 values from CC's
 * mockup + SunBiz Adon-team standard cadence.
 */

export const STAGE_SLA_DAYS: Record<string, number> = {
  // Lead stages
  imported: 2,
  not_interested: 999,
  hot_lead: 1,
  missing_info: 3,
  declined: 999,
  follow_up: 2,
  sent_application: 5,
  viewed_application: 2,
  signed_application: 2,
  default: 7,
  submitted: 5,
  approved: 30,
  // Opportunity stages
  application_in: 2,
  shopping: 2,
  selling: 2,
  requested_docs: 2,
  docs_out: 2,
  login: 1,
  follow_ups: 3,
  submitted_to_underwriting: 2,
  approved_open_offers: 1,
  contracts_ordered: 2,
  funded: 999,
  approved_never_funded: 5,
  no_offers_available: 7,
  dead_file: 999,
};

/** Stages an "active" lead can be in. Excludes terminal stages. */
export const ACTIVE_STAGES = new Set<string>([
  "imported",
  "hot_lead",
  "missing_info",
  "follow_up",
  "sent_application",
  "viewed_application",
  "signed_application",
  "default",
  "submitted",
  "application_in",
  "shopping",
  "selling",
  "requested_docs",
  "docs_out",
  "login",
  "follow_ups",
  "submitted_to_underwriting",
  "approved_open_offers",
  "contracts_ordered",
  "approved_never_funded",
]);

/** Stages where the operator should be advancing the deal NOW. */
export const READY_TO_ADVANCE_STAGES = new Set<string>([
  "viewed_application",
  "signed_application",
  "application_in",
  "approved",
  "docs_out",
  "login",
  "contracts_ordered",
  "approved_open_offers",
]);

export function slaDaysFor(stage: string): number {
  return STAGE_SLA_DAYS[stage] ?? 7;
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
