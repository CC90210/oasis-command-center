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

/**
 * First-touch alert for the ai-audit funnel.
 *
 * The completion alert above only fires on the LAST step. That was fine
 * while the only way in was the funnel's own first page, but the marketing
 * site's inline CTA (components/marketing/AuditForm.tsx) submits step 0 on
 * its own and hands the visitor onward — so a visitor who fills in name,
 * email and company and then closes the tab produced a real lead row that
 * alerted nobody. A form that captures a qualified name in silence is a
 * drop box, not a funnel.
 *
 * Telegram only, deliberately. The welcome EMAIL still belongs to
 * completion: mailing someone the moment they type an address, then again
 * two minutes later when they finish, reads as automated and earns a spam
 * complaint. This tells the operator; it does not talk to the lead.
 *
 * Deduped on submission count rather than on a flag: a returning visitor is
 * smart-matched onto their existing lead, so "is this their first step-0 on
 * this form" is the only question that actually distinguishes a new inbound
 * from someone reloading the page.
 */
export async function notifyAiAuditStarted(input: {
  db: SupabaseClient;
  formId: string;
  leadId: string;
  answers: Record<string, unknown>;
}): Promise<void> {
  const { db, formId, leadId, answers } = input;

  try {
    const { count, error } = await db
      .from("form_submissions")
      .select("id", { count: "exact", head: true })
      .eq("form_id", formId)
      .eq("lead_id", leadId);

    // Fail closed on an unreadable count: a missed alert is recoverable
    // (the lead is still in the pipeline), a duplicate alert every time
    // someone refreshes trains the operator to ignore the channel.
    if (error || (count ?? 0) !== 1) return;
  } catch {
    return;
  }

  const s = (k: string) => String(answers[k] ?? "").trim();
  const name = s("name") || "Someone";
  const company = s("company");
  const email = s("email");
  const website = s("website");

  const lines = [
    "🟢 New inbound — OASIS AI audit started",
    "",
    `${name}${company ? ` · ${company}` : ""}`,
    email ? `✉️ ${email}` : "",
    website ? `🔗 ${website}` : "",
    "",
    "Step 1 of 5 complete. Score arrives if they finish.",
  ].filter(Boolean);

  const r = await sendTelegram(lines.join("\n"));
  if (!r.ok) console.error("[ai-audit.started] telegram:", r.reason);
}

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
