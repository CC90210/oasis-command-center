/**
 * Shared write-time guard for drip sequence copy — one function both the
 * create (POST) and edit (PATCH) routes run over EVERY step before anything
 * persists. Closes the 2026-07-22 recon gaps: the create path previously
 * skipped compliance entirely, SMS steps were unguarded on write, and an
 * edit could silently drop {{lead.*}} merge tokens or the SMS STOP line.
 *
 * Layers per step (fail-closed):
 *   1. sanitizeBlastMessage — lender names (live tenant list) + broker/ISO
 *      positioning phrases + em-dash strip. DB error ⇒ block.
 *   2. Token preservation — when prior steps are supplied (PATCH), the set of
 *      {{tokens}} in the edited copy must not LOSE any token the prior step
 *      referenced (adding is fine). A dropped token silently breaks the
 *      merge at send time.
 *   3. SMS STOP line — an SMS step whose prior copy carried an opt-out
 *      instruction cannot save without one.
 *
 * Returns cleaned steps (dashes stripped on every copy field) or a typed
 * rejection naming the step + rule + evidence.
 */

import { sanitizeBlastMessage, stripDashes } from "@/lib/integrations/blast-safety";
import type { DripStep } from "./types";
import { droppedTokens, stepCopyJoined, stopLineRemoved } from "./edit-guard-core";

export type GuardRejection = {
  ok: false;
  error: "blocked_copy" | "tokens_dropped" | "stop_line_removed" | "safety_check_failed";
  step: number;
  message: string;
  detail?: string[];
};
export type GuardResult = { ok: true; steps: DripStep[] } | GuardRejection;

/**
 * @param steps       the incoming (already parseDripSteps-validated) steps
 * @param priorSteps  the currently-stored steps, when this is an edit; pass
 *                    null on create (token/STOP preservation has no baseline)
 */
export async function guardSequenceSteps(
  tenantId: string,
  steps: DripStep[],
  priorSteps: DripStep[] | null,
): Promise<GuardResult> {
  const cleaned: DripStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const joined = stepCopyJoined(s);

    // 1. Compliance denylist — EVERY channel (SMS was write-unguarded before).
    const guard = await sanitizeBlastMessage(tenantId, joined, { checkPositioning: true });
    if (!guard.ok) {
      return {
        ok: false,
        error: guard.reason === "safety_check_failed" ? "safety_check_failed" : "blocked_copy",
        step: i,
        message: `Step ${i + 1}: ${guard.message}`,
      };
    }

    const prior = priorSteps && i < priorSteps.length ? priorSteps[i] : null;

    // 2. Merge-token preservation vs the prior copy of the SAME step slot.
    if (prior) {
      const dropped = droppedTokens(prior, s);
      if (dropped.length) {
        return {
          ok: false,
          error: "tokens_dropped",
          step: i,
          message:
            `Step ${i + 1}: this edit removes merge field(s) ${dropped.map((t) => `{{${t}}}`).join(", ")} — ` +
            `they fill from the lead at send time. Keep them, or intentionally rewrite the step without them by ` +
            `first saving a version that renames the step copy entirely.`,
          detail: dropped,
        };
      }
    }

    // 3. SMS opt-out line preservation.
    if (s.channel === "sms" && prior && prior.channel === "sms") {
      if (stopLineRemoved(prior, s)) {
        return {
          ok: false,
          error: "stop_line_removed",
          step: i,
          message: `Step ${i + 1}: the SMS opt-out instruction (e.g. "Reply STOP to opt out") was removed — it must stay.`,
        };
      }
    }

    cleaned.push({
      ...s,
      subject: s.subject ? stripDashes(s.subject) : s.subject,
      body: stripDashes(s.body),
      ...(s.subject_variants ? { subject_variants: s.subject_variants.map(stripDashes) } : {}),
      ...(s.body_variants ? { body_variants: s.body_variants.map(stripDashes) } : {}),
    });
  }
  return { ok: true, steps: cleaned };
}
