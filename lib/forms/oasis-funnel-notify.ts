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
    sendTelegram(buildOasisFunnelAlert(answers)).then((r) => {
      if (!r.ok) console.error("[oasis-funnel.notify] telegram:", r.reason);
    }),
    sendOasisFunnelWelcome({ db, tenantId, leadId, answers }),
  ]);
}
