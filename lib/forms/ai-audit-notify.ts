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
import { AI_AUDIT_STEP_COUNT } from "@/lib/forms/oasis-ai-audit-seed";
import { deliverWelcomeEmail } from "@/lib/forms/oasis-funnel-email";
import { buildAiAuditAlert, composeAiAuditWelcome } from "@/lib/forms/ai-audit-format";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import type { ScoreBreakdown } from "@/lib/forms/ai-audit-ingest";

/** Distinct source tag → its own idempotency slot, so an ai-audit confirmation
 *  and a personal-funnel welcome never suppress each other for the same lead. */
export const AI_AUDIT_WELCOME_SOURCE = "ai_audit_welcome";

/**
 * Source tag for the "alert could not be delivered" marker.
 *
 * Deliberately NOT "ai_audit_funnel": ingestAiAuditSubmission treats the
 * presence of ANY row with that source as proof the submission was already
 * processed, so filing a failure marker under it would make every retry
 * return already_ingested and permanently suppress both the ingest and the
 * alert for that lead. A record that a notification broke must never be
 * able to silence the notification.
 */
export const AI_AUDIT_ALERT_SOURCE = "ai_audit_alert";

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
    // Derived from the seed, so the alert cannot drift out of step with
    // the funnel the way the hardcoded version did.
    `Step 1 of ${AI_AUDIT_STEP_COUNT} complete. Score arrives if they finish.`,
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

  // The email goes FIRST, and its result is carried into the alert.
  //
  // These used to run concurrently via allSettled so neither could block the
  // other. That was defensible, but it meant the Telegram alert could not say
  // whether the lead had actually been emailed — and CC's ask is one message
  // that says a form came in AND that we replied to it. Sequencing costs a
  // few hundred ms inside an `after()` callback the visitor never waits on,
  // and buys an alert that describes the whole event instead of half of it.
  // A failing email still cannot stop the alert: deliverWelcomeEmail returns
  // a result rather than throwing, and the alert reports the failure.
  let emailNote = "";
  try {
    const r = await deliverWelcomeEmail({
      db, tenantId, leadId, toEmail,
      source: AI_AUDIT_WELCOME_SOURCE, subject, body,
    });
    if (r.sent) {
      emailNote = "sent";
    } else if (r.reason === "already_sent") {
      emailNote = "already sent earlier";
    } else if (r.reason === "suppressed") {
      emailNote = "NOT sent — address suppressed";
    } else {
      emailNote = `NOT sent — ${r.reason ?? "unknown"}`;
      console.error("[ai-audit.notify] welcome email:", r.reason);
    }
  } catch (err) {
    emailNote = "NOT sent — threw";
    console.error("[ai-audit.notify] welcome email threw:", err);
  }

  const alert = buildAiAuditAlert(answers, score, {
    emailStatus: emailNote,
    inboxUrl: toEmail
      ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(toEmail)}`
      : "",
  });

  const tg = await sendTelegram(alert).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  if (!tg.ok) {
    console.error("[ai-audit.notify] telegram:", tg.reason);
    // A LEAD ALERT THAT FAILS SILENTLY IS THE WORST FAILURE MODE HERE.
    // console.error goes to a Vercel log nobody reads; CC's actual
    // experience was a lead arriving with no notification and no trace of
    // why. Leave a durable row on the lead's own timeline, so the failure
    // is visible in the dashboard next to the lead it belongs to even when
    // the notification channel itself is the thing that is broken.
    await recordAlertFailure({
      db, tenantId, leadId,
      source: AI_AUDIT_ALERT_SOURCE,
      label: "AI audit",
      reason: tg.reason ?? "unknown",
      extra: `The welcome email was ${emailNote}.`,
      tag: "ai-audit.notify",
    });
  }
}
