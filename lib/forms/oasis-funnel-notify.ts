/**
 * oasis-funnel-notify.ts — fan-out for a CC funnel submission.
 *
 * Fires the two instant side-effects ported from cc-funnel, in parallel and
 * non-blocking: (1) a Telegram ping to CC with the lead's answers, (2) a
 * Claude-personalized welcome email to the lead. The lead itself already landed
 * in the pipeline (createRecord) before this runs. Invoked from
 * app/api/forms/submit via `after()` so it never delays the prospect's response.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegram } from "@/lib/notify/telegram";
import { buildOasisFunnelAlert } from "@/lib/forms/oasis-funnel-format";
import { sendOasisFunnelWelcome } from "@/lib/forms/oasis-funnel-email";
import { recordAlertFailure } from "@/lib/forms/alert-failure";

/** Marker source for a failed alert on this funnel. Distinct from any
 *  source an idempotency check queries — see recordAlertFailure. */
const OASIS_FUNNEL_ALERT_SOURCE = "oasis_funnel_alert";

export type OasisFunnelNotifyInput = {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  /** Merged form answers across all steps. */
  answers: Record<string, unknown>;
};

export async function notifyOasisFunnelSubmission(
  input: OasisFunnelNotifyInput,
): Promise<void> {
  const { db, tenantId, leadId, answers } = input;
  await Promise.allSettled([
    // operator: CC's OASIS funnel.
    sendTelegram(buildOasisFunnelAlert(answers), { lane: "operator" }).then(async (r) => {
      if (r.ok) return;
      console.error("[oasis-funnel.notify] telegram:", r.reason);
      // Same defect the ai-audit funnel had: the only record of a failed
      // lead alert was a console line in a log nobody reads, so a lead
      // could arrive with no notification and no trace of why. Fixed in
      // both places, because a visitor does not know or care which funnel
      // they filled in.
      await recordAlertFailure({
        db, tenantId, leadId,
        source: OASIS_FUNNEL_ALERT_SOURCE,
        label: "OASIS funnel",
        reason: r.reason ?? "unknown",
        tag: "oasis-funnel.notify",
      });
    }),
    // Inspect the email result too. This call used to discard it while the
    // Telegram branch above logged its failure — so a dead GMAIL_APP_PASSWORD
    // silently cost every lead their welcome email with nothing in the logs,
    // and only the Telegram half was observable. "already_sent"/"suppressed"
    // are correct outcomes, not failures, and stay quiet.
    sendOasisFunnelWelcome({ db, tenantId, leadId, answers }).then((r) => {
      if (!r.sent && r.reason &&
          !["already_sent", "suppressed", "no_usable_email"].includes(r.reason)) {
        console.error("[oasis-funnel.notify] welcome email:", r.reason);
      }
    }),
  ]);
}
