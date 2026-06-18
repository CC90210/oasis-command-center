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

/**
 * Build the server-authoritative answer context for `show_if` evaluation +
 * notifications. CRITICAL trust boundary: each submission's payload (prior
 * STORED rows AND the current request) contributes ONLY keys declared as fields
 * on ITS OWN step. This blocks a crafted body from (a) injecting a key the form
 * never declared, or (b) overriding a controller field that lives on a different
 * step — e.g. forging `interests: []` in the step-1 body to make a required AI
 * field evaluate as hidden and skip its required check. Field names are unique
 * form-wide, so the per-step whitelist is lossless for legitimate answers.
 */
export function buildAnswerContext(
  steps: ReadonlyArray<{ fields: ReadonlyArray<{ name: string }> }>,
  priorRows: ReadonlyArray<{ step_index: number; payload: unknown }>,
  currentStepIndex: number,
  currentPayload: Record<string, unknown>,
): Record<string, unknown> {
  const allowedByStep = steps.map((s) => new Set(s.fields.map((f) => f.name)));
  const ctx: Record<string, unknown> = {};
  const mergeWhitelisted = (stepIdx: number, payload: unknown) => {
    const allowed = allowedByStep[stepIdx];
    if (!allowed || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (allowed.has(k)) ctx[k] = v;
    }
  };
  for (const r of priorRows) mergeWhitelisted(Number(r.step_index), r.payload);
  mergeWhitelisted(currentStepIndex, currentPayload);
  return ctx;
}
