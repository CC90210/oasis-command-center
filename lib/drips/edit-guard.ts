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
import { sequenceDroppedTokens, smsStopRemoved, stepCopyJoined } from "./edit-guard-core";

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
 * @param opts.allowTokenRemoval  operator explicitly confirmed the removed
 *                    merge fields are intentional (the builder's second-step
 *                    "remove anyway" flow). STOP-line removal has NO override.
 */
export async function guardSequenceSteps(
  tenantId: string,
  steps: DripStep[],
  priorSteps: DripStep[] | null,
  opts: { allowTokenRemoval?: boolean } = {},
): Promise<GuardResult> {
  const cleaned: DripStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const joined = stepCopyJoined(s);

    // 1. Compliance denylist — EVERY channel (SMS was write-unguarded before)
    //    and every copy field incl. body_html (what actually delivers).
    const guard = await sanitizeBlastMessage(tenantId, joined, { checkPositioning: true });
    if (!guard.ok) {
      return {
        ok: false,
        error: guard.reason === "safety_check_failed" ? "safety_check_failed" : "blocked_copy",
        step: i,
        message: `Step ${i + 1}: ${guard.message}`,
      };
    }

    cleaned.push({
      ...s,
      subject: s.subject ? stripDashes(s.subject) : s.subject,
      body: stripDashes(s.body),
      ...(s.body_html ? { body_html: stripDashes(s.body_html) } : {}),
      ...(s.subject_variants ? { subject_variants: s.subject_variants.map(stripDashes) } : {}),
      ...(s.body_variants ? { body_variants: s.body_variants.map(stripDashes) } : {}),
    });
  }

  // 2 + 3. Preservation checks are SEQUENCE-level (codex P1: per-index
  // comparison false-rejected reorders/inserts/deletes — moving copy between
  // steps is legitimate; losing it from the sequence is what flags).
  if (priorSteps) {
    const dropped = sequenceDroppedTokens(priorSteps, steps);
    if (dropped.length && !opts.allowTokenRemoval) {
      return {
        ok: false,
        error: "tokens_dropped",
        step: -1,
        message:
          `This edit removes merge field(s) ${dropped.map((t) => `{{${t}}}`).join(", ")} from the whole sequence — ` +
          `they fill from the lead at send time. Keep them somewhere, or confirm the removal is intentional.`,
        detail: dropped,
      };
    }
    if (smsStopRemoved(priorSteps, steps)) {
      return {
        ok: false,
        error: "stop_line_removed",
        step: -1,
        message:
          'The SMS opt-out instruction (e.g. "Reply STOP to opt out") no longer appears in any SMS step — at least one must keep it.',
      };
    }
  }

  return { ok: true, steps: cleaned };
}
