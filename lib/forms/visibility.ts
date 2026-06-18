/**
 * forms/visibility.ts — single source of truth for conditional field/step
 * display (`show_if`). Every consumer evaluates visibility through these
 * helpers so a field hidden by a condition is hidden EVERYWHERE: rendered
 * nowhere (FormRenderer), never required (FormPublicClient + the server-side
 * validator in api/forms/submit), and dropped from the stored payload
 * (buildSubmitPayload). One evaluator → no drift between client UX and the
 * server trust boundary.
 *
 * Conditions key off another field by `name`. Because field names are unique
 * across steps, callers pass a MERGED value map — all answered steps flattened
 * — so a later step's field can react to an earlier selection (the CC funnel:
 * pick interest on step 0 → the matching branch of questions appears on
 * step 1).
 *
 * Semantics:
 *   - Multiple predicates on one condition AND together.
 *   - `equals`  → scalar  === equals
 *   - `includes`→ array    .includes(includes)        (multiselect membership)
 *   - `in`      → scalar   ∈ in[]
 *   - `any_of`  → array    ∩ any_of[] is non-empty
 *   - A missing/absent target value → FALSE (hidden). This is the correct
 *     default before the controlling field has been answered.
 */
import type { FormField, FormShowIf, FormStep } from "./types";

export function isConditionMet(
  cond: FormShowIf,
  values: Record<string, unknown>,
): boolean {
  const target = values[cond.field];
  if (cond.equals !== undefined) {
    if (target !== cond.equals) return false;
  }
  if (cond.includes !== undefined) {
    if (!Array.isArray(target) || !target.includes(cond.includes)) return false;
  }
  if (cond.in !== undefined) {
    if (typeof target !== "string" || !cond.in.includes(target)) return false;
  }
  if (cond.any_of !== undefined) {
    if (!Array.isArray(target) || !cond.any_of.some((x) => target.includes(x))) {
      return false;
    }
  }
  return true;
}

export function isFieldVisible(
  field: Pick<FormField, "show_if">,
  values: Record<string, unknown>,
): boolean {
  return !field.show_if || isConditionMet(field.show_if, values);
}

export function isStepVisible(
  step: Pick<FormStep, "show_if">,
  values: Record<string, unknown>,
): boolean {
  return !step.show_if || isConditionMet(step.show_if, values);
}
