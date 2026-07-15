/**
 * Pure decision for form-driven lead stage transitions — extracted from
 * app/api/forms/submit/route.ts so it's unit-testable (it's the
 * downgrade/reactivation logic Codex flagged, and the reactivation policy CC
 * locked on 2026-06-18).
 *
 * Terminal-stage policy:
 *   - HARD_TERMINAL (default = repayment failure, opted_out = explicit
 *     unsubscribe): NEVER auto-changed by a form submission. Resetting
 *     opted_out would be a CASL/consent violation.
 *   - REACTIVATABLE_TERMINAL: was {ghost, declined}; both left the lead board
 *     (2026-07-15 — ghost→follow_up, declined→Applications), so the lead board
 *     now has no reactivatable-terminal stage. Kept as an (empty) extension point.
 *   - Active funnel: never downgrade a more-advanced lead (a returning merchant
 *     re-submitting the interest form must not be knocked back to the entry).
 */

export const REACTIVATABLE_TERMINAL_STAGES = new Set<string>([]);
export const HARD_TERMINAL_STAGES = new Set(["default", "opted_out"]);

/**
 * Returns true when applying `targetStage` would be a downgrade that should be
 * SKIPPED (preserve the lead's current stage). `stageOrder` is the funnel order
 * (e.g. LEAD_PIPELINE_STAGES keys); earlier index = earlier in the funnel.
 */
export function isFormStageDowngrade(
  curStage: string | null | undefined,
  targetStage: string,
  stageOrder: string[],
): boolean {
  if (typeof curStage !== "string" || !curStage || curStage === targetStage) return false;
  // Hard-terminal: always preserve (never auto-changed by a form).
  if (HARD_TERMINAL_STAGES.has(curStage)) return true;
  // Reactivatable-terminal: a re-submission re-engages → apply the target.
  if (REACTIVATABLE_TERMINAL_STAGES.has(curStage)) return false;
  const ci = stageOrder.indexOf(curStage);
  const ti = stageOrder.indexOf(targetStage);
  // FAIL CLOSED on an UNKNOWN current stage (legacy/custom value not in the
  // funnel, e.g. "imported"): we can't prove it's safe to overwrite, so
  // preserve it rather than risk clobbering an opt-out/terminal-equivalent
  // stage we don't recognize. (Codex audit 2026-06-18 [high]: unknown stages
  // fail-open.) A new lead is unaffected — it's already at the target, so the
  // equal-stage short-circuit above returns false (apply) before reaching here.
  if (ci === -1) return true;
  // Active funnel: downgrade only when the current stage is strictly later.
  return ti >= 0 && ci > ti;
}
