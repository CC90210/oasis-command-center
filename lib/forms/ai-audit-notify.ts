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
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
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
 * Deduped by "is this submission the FIRST step-0 on this form for this
 * lead", not by counting rows. A returning visitor is smart-matched onto
 * their existing lead, so the count is the only thing that distinguishes a
 * new inbound from a repeat — but counting is racy. Two near-simultaneous
 * submits (double-click, or back-then-resubmit) both land their rows
 * before either callback reads, so both observe a count of 2 and NEITHER
 * fires: the alert disappears in exactly the case where a lead was most
 * eager. Asking "is the oldest row mine" instead always has exactly one
 * winner, whatever order the callbacks run in.
 *
 * KNOWN RESIDUAL, not fixed here. If two concurrent submits each create
 * their OWN lead — possible because findExistingLead + createRecord in
 * app/api/forms/submit/route.ts are not atomic, so both can look up, miss,
 * and insert — then each lead has exactly one submission, each callback is
 * legitimately the oldest for its own lead, and CC gets two pings. The
 * duplicate ping is a symptom; the duplicate LEAD is the actual defect, and
 * it predates this function. Fixing it means a uniqueness guarantee on lead
 * creation (a partial unique index on tenant + lower(email), or an upsert),
 * which changes shared intake behaviour for every tenant and every form —
 * an architecture decision to raise with CC, not to make from inside a
 * notification helper.
 */
export async function notifyAiAuditStarted(input: {
  db: SupabaseClient;
  tenantId: string;
  formId: string;
  leadId: string;
  submissionId: string;
  answers: Record<string, unknown>;
}): Promise<void> {
  const { db, tenantId, formId, leadId, submissionId, answers } = input;

  try {
    // (tenant_id, lead_id, submitted_at) is indexed — see migration 042.
    // id is the tiebreak for two rows sharing a timestamp, so the winner
    // is deterministic even at identical clock values.
    const { data, error } = await db
      .from("form_submissions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("form_id", formId)
      .eq("lead_id", leadId)
      .order("submitted_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);

    // Fail closed on an unreadable result: a missed alert is recoverable
    // (the lead is still in the pipeline), whereas an alert on every
    // refresh trains the operator to ignore the channel.
    if (error || !data?.length || data[0].id !== submissionId) return;
  } catch {
    return;
  }

  // sendTelegram posts with parse_mode: "HTML", and every value below is
  // typed by a stranger into a public form. Unescaped, a company called
  // "Barnes & Noble" is enough to make Telegram reject the message as
  // malformed HTML — the alert would fail silently on ordinary input, let
  // alone hostile input. Same helper ai-audit-format.ts uses.
  const e = escapeTelegramHtml;
  const s = (k: string) => e(String(answers[k] ?? "").trim());
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
    // Four steps, per AI_AUDIT_STEPS in lib/forms/oasis-ai-audit-seed.ts.
    // Keep this in step with the funnel or the alert quietly lies about
    // how far along the lead actually is.
    "Step 1 of 4 complete. Score arrives if they finish.",
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
