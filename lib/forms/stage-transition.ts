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
 *   - REACTIVATABLE_TERMINAL (ghost, declined): a new form submission is a
 *     genuine re-engagement → resurface the lead to the form's target stage.
 *   - Active funnel: never downgrade a more-advanced lead (a returning merchant
 *     re-submitting the interest form must not be knocked back to the entry).
 */

export const REACTIVATABLE_TERMINAL_STAGES = new Set(["ghost", "declined"]);
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
  // Active funnel: downgrade only when both are known stages and current is
  // strictly later. Unknown/equal stages → not a downgrade (apply).
  const ci = stageOrder.indexOf(curStage);
  const ti = stageOrder.indexOf(targetStage);
  return ci >= 0 && ti >= 0 && ci > ti;
}
