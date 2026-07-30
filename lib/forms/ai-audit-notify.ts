/**
 * ai-audit-notify.ts — fan-out for an AI-audit funnel submission.
 *
 * WHAT WAS MISSING. The ai-audit block in app/api/forms/submit/route.ts called
 * ingestAiAuditSubmission and nothing else — so the lead was scored and written
 * to the timeline, and CC was never told. A qualification funnel that scores a
 * lead 90/100 and stays silent is worse than no funnel: the work happens and
 * nobody acts on it. (Found 2026-07-30 while auditing why the OTHER funnel path
 * was noisy.)
 *
 * Runs inside `after()` on a request that has ALREADY captured the lead, so
 * every branch soft-fails: the prospect's submission is never affected.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegram } from "@/lib/notify/telegram";
import { deliverWelcomeEmail } from "@/lib/forms/oasis-funnel-email";
import { buildAiAuditAlert, composeAiAuditWelcome } from "@/lib/forms/ai-audit-format";
import type { ScoreBreakdown } from "@/lib/forms/ai-audit-ingest";

/** Distinct source tag → its own idempotency slot, so an ai-audit confirmation
 *  and a personal-funnel welcome never suppress each other for the same lead. */
export const AI_AUDIT_WELCOME_SOURCE = "ai_audit_welcome";

export type AiAuditNotifyInput = {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  answers: Record<string, unknown>;
  score: ScoreBreakdown;
};

export async function notifyAiAuditSubmission(
  input: AiAuditNotifyInput,
): Promise<void> {
  const { db, tenantId, leadId, answers, score } = input;
  const toEmail = String(answers.email ?? "").trim().toLowerCase();
  const { subject, body } = composeAiAuditWelcome(answers);

  // Independent side-effects: a dead Gmail credential must not cost CC the
  // Telegram alert, and a missing Telegram token must not cost the lead their
  // confirmation. allSettled, and BOTH results are inspected — the sibling
  // orchestrator discarded the email result, which is how a broken welcome
  // email stays invisible.
  await Promise.allSettled([
    sendTelegram(buildAiAuditAlert(answers, score)).then((r) => {
      if (!r.ok) console.error("[ai-audit.notify] telegram:", r.reason);
    }),
    deliverWelcomeEmail({
      db, tenantId, leadId, toEmail,
      source: AI_AUDIT_WELCOME_SOURCE, subject, body,
    }).then((r) => {
      // "already_sent" and "suppressed" are correct outcomes, not failures.
      if (!r.sent && r.reason && !["already_sent", "suppressed", "no_usable_email"].includes(r.reason)) {
        console.error("[ai-audit.notify] welcome email:", r.reason);
      }
    }),
  ]);
}
