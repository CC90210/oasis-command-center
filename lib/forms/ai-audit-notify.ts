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
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegram } from "@/lib/notify/telegram";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { AI_AUDIT_STEP_COUNT } from "@/lib/forms/oasis-ai-audit-seed";
import { buildAiAuditAlert, composeAiAuditWelcome } from "@/lib/forms/ai-audit-format";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { isFirstSubmissionForLead } from "@/lib/forms/first-submission";
import type { ScoreBreakdown } from "@/lib/forms/ai-audit-ingest";
import {
  queueAiAuditConfirmation,
  TRANSACTIONAL_OUTBOX_SOURCE,
} from "@/lib/forms/transactional-outbox";

/** Distinct source tag → its own idempotency slot, so an ai-audit confirmation
 *  and a personal-funnel welcome never suppress each other for the same lead. */
export const AI_AUDIT_WELCOME_SOURCE = TRANSACTIONAL_OUTBOX_SOURCE;

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

type AiAuditSalesEvent = "started" | "completed";

function deterministicEventId(input: {
  tenantId: string;
  formId: string;
  leadId: string;
  event: AiAuditSalesEvent;
}): string {
  const digest = createHash("sha256")
    .update(
      `oasis-ai-audit-sales-event:v1:${input.tenantId}:${input.formId}:${input.leadId}:${input.event}`,
      "utf8",
    )
    .digest("hex");
  // Valid both for UUID-backed production rows and text-backed Turso mirrors.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Persist the Sales handoff idempotently and report failures to the caller. */
export async function ensureAiAuditSalesEvent(input: {
  db: SupabaseClient;
  tenantId: string;
  formId: string;
  leadId: string;
  event: AiAuditSalesEvent;
  submissionId?: string;
  score?: ScoreBreakdown;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const payload: Record<string, unknown> = {
      lead_id: input.leadId,
      form_id: input.formId,
      lifecycle: "warm_inbound",
      tenant_id: input.tenantId,
    };
    if (input.submissionId) payload.submission_id = input.submissionId;
    if (input.score) {
      payload.score = input.score.score;
      payload.qualification = input.score.status;
    }
    const result = await input.db.from("agent_events").upsert(
      {
        id: deterministicEventId(input),
        event_type:
          input.event === "started" ? "OASIS_AI_AUDIT_STARTED" : "OASIS_AI_AUDIT_COMPLETED",
        publisher_agent: "dept:sales",
        target_agent: "dept:sales",
        severity: input.score?.status === "qualified" ? "warn" : "info",
        payload,
        correlation_id: input.tenantId,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

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

  // Persist before Telegram dedupe. A repeat step-0 submission can repair a
  // missing event without producing another operator notification.
  const salesEvent = await ensureAiAuditSalesEvent({
    db,
    tenantId,
    formId,
    leadId,
    event: "started",
    submissionId,
  });
  if (!salesEvent.ok) {
    console.error("[ai-audit.started] Sales event:", salesEvent.error);
  }

  // The first-submission rule (oldest row wins, fail closed) is shared with the
  // offer-page lead alert, so the two can never disagree about what a new lead
  // is. See lib/forms/first-submission.ts.
  if (!(await isFirstSubmissionForLead({ db, tenantId, formId, leadId, submissionId }))) return;

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

  // operator: this is CC's own funnel — a lead submitted on oasisai.work.
  const r = await sendTelegram(lines.join("\n"), { lane: "operator" });
  if (!r.ok) {
    console.error("[ai-audit.started] telegram:", r.reason);
    // The step-0 alert matters MORE than the completion one, not less: it
    // fires for someone who filled in their details and then bounced at
    // step 2. There is no welcome email and no score for that visitor, so
    // this alert is the only thing that exists. Losing it silently loses
    // the lead entirely.
    await recordAlertFailure({
      db, tenantId, leadId,
      source: AI_AUDIT_ALERT_SOURCE,
      label: "AI audit (started)",
      reason: r.reason ?? "unknown",
      extra: "This visitor started the funnel but has not completed it.",
      tag: "ai-audit.started",
    });
  }
}

export type AiAuditNotifyInput = {
  db: SupabaseClient;
  tenantId: string;
  formId: string;
  leadId: string;
  answers: Record<string, unknown>;
  score: ScoreBreakdown;
};

export async function ensureAiAuditSubmissionDelivery(
  input: AiAuditNotifyInput,
): Promise<{ emailNote: string; salesEventOk: boolean }> {
  const { db, tenantId, formId, leadId, answers, score } = input;
  const salesEvent = await ensureAiAuditSalesEvent({
    db,
    tenantId,
    formId,
    leadId,
    event: "completed",
    score,
  });
  if (!salesEvent.ok) {
    console.error("[ai-audit.notify] Sales event:", salesEvent.error);
  }

  const toEmail = String(answers.email ?? "").trim().toLowerCase();
  const { subject, body } = composeAiAuditWelcome(answers);
  let emailNote = "";
  try {
    const firstName = String(answers.name ?? "there").trim().split(/\s+/)[0] || "there";
    const queued = await queueAiAuditConfirmation({
      db,
      tenantId,
      formId,
      leadId,
      email: toEmail,
      phone: answers.phone,
      emailSubject: subject,
      emailBody: body,
      smsBody: `${firstName}, thanks for completing your OASIS AI audit. We have your answers and will follow up with the clearest next step. Reply STOP to opt out.`,
    });
    if (queued.email.queued) {
      emailNote = "queued through send_gateway";
    } else if (queued.email.reason === "already_queued") {
      emailNote = "already queued earlier";
    } else if (queued.email.reason === "already_sent") {
      emailNote = "already sent earlier";
    } else {
      emailNote = `NOT queued — ${queued.email.reason ?? "unknown"}`;
      console.error("[ai-audit.notify] welcome email queue:", queued.email.reason);
    }
  } catch (err) {
    emailNote = "NOT queued — threw";
    console.error("[ai-audit.notify] confirmation queue threw:", err);
  }
  return { emailNote, salesEventOk: salesEvent.ok };
}

export async function notifyAiAuditSubmission(
  input: AiAuditNotifyInput,
): Promise<void> {
  const { db, tenantId, leadId, answers, score } = input;
  const toEmail = String(answers.email ?? "").trim().toLowerCase();
  // Both writes use deterministic keys. A repeat submission repairs a missing
  // event or queue row without duplicating either one.
  const { emailNote } = await ensureAiAuditSubmissionDelivery(input);

  const alert = buildAiAuditAlert(answers, score, {
    emailStatus: emailNote,
    inboxUrl: toEmail
      ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(toEmail)}`
      : "",
  });

  const tg = await sendTelegram(alert, { lane: "operator" }).catch((err) => ({
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
