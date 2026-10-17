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
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import { AI_AUDIT_SLUG, AI_AUDIT_STEP_COUNT, AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";
import {
  alertLeadFactLines,
  buildAiAuditAlert,
  composeAiAuditWelcome,
  type WelcomeLinks,
} from "@/lib/forms/ai-audit-format";
import { signFormLink } from "@/lib/form-links";
import { buildResumeUrl } from "@/lib/forms/resume-link";
import { marketingSendAllowed } from "@/lib/consent/marketing-send-gate";
import { SITE_ORIGIN } from "@/lib/marketing/routes";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { isFirstSubmissionForLead } from "@/lib/forms/first-submission";
import { formatBookedTime } from "@/lib/forms/public-booking-alert";
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

type AiAuditSalesEvent = "started" | "completed" | "booked";

function deterministicEventId(input: {
  tenantId: string;
  formId: string;
  leadId: string;
  event: AiAuditSalesEvent;
  /**
   * A booked call is one event PER APPOINTMENT. Keyed by lead alone, a cancelled and
   * rebooked lead kept its first event (the upsert ignores duplicates) and the Sales
   * handoff carried the old time and Meet link (review of #611).
   */
  appointmentId?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `oasis-ai-audit-sales-event:v1:${input.tenantId}:${input.formId}:${input.leadId}:${input.event}` +
        (input.appointmentId ? `:${input.appointmentId}` : ""),
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
  booking?: { startsAt: string; meetUrl: string; appointmentId: string };
  /** Completed with the call already booked (readBookedCall). */
  bookedCall?: string;
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
    if (input.event === "completed") payload.booking_status = input.bookedCall ? "booked" : "unbooked";
    if (input.booking) {
      payload.booking_status = "booked";
      payload.starts_at = input.booking.startsAt;
      payload.meet_url = input.booking.meetUrl;
      payload.appointment_id = input.booking.appointmentId;
    }
    const result = await input.db.from("agent_events").upsert(
      {
        id: deterministicEventId({ ...input, appointmentId: input.booking?.appointmentId }),
        event_type:
          input.event === "started"
            ? "OASIS_AI_AUDIT_STARTED"
            : input.event === "booked"
              ? "OASIS_AI_AUDIT_BOOKED"
              : "OASIS_AI_AUDIT_COMPLETED",
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
 * The lead row's `data`, scoped to this workspace, for the started alert's
 * Revenue and Bottleneck lines. Best effort: a failed read is logged and costs
 * those two lines, never the alert itself.
 */
async function readLeadData(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  tag = "ai-audit.started",
): Promise<Record<string, unknown>> {
  try {
    const res = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .eq("id", leadId)
      .maybeSingle();
    if (res.error) {
      console.error(`[${tag}] lead read:`, res.error.message);
      return {};
    }
    let data: unknown = (res.data as { data?: unknown } | null)?.data;
    // The Turso adapter can hand back the JSON column as text.
    if (typeof data === "string") data = JSON.parse(data);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch (err) {
    console.error(`[${tag}] lead read threw:`, err);
    return {};
  }
}

/**
 * The call an appointment holds, as the alert prints it, or undefined.
 *
 * The calendar opens after the contact step (isEarlyPublicBookingFormSlug), so
 * a lead can finish the questions with the call already booked. Booked means
 * the appointment is still scheduled, verified on Google Calendar, and in the
 * future: some cancel paths change only the appointment, so a cancelled call's
 * time can stay on the lead (Codex review of #667), and a call in the past is
 * not one to confirm.
 */
export function bookedCallFromAppointment(
  row: { scheduled_for?: unknown; status?: unknown; calendar_status?: unknown } | null,
  nowMs = Date.now(),
): string | undefined {
  if (!row || row.status !== "scheduled" || row.calendar_status !== "verified") return undefined;
  const at = typeof row.scheduled_for === "string" ? row.scheduled_for.trim() : "";
  const startsMs = Date.parse(at);
  if (!at || !Number.isFinite(startsMs) || startsMs <= nowMs) return undefined;
  return formatBookedTime(at);
}

/**
 * The call this lead has booked, read from its appointment (the one the lead
 * points at), or undefined. A failed read counts as not booked: the email then
 * offers a time, as before, and the calendar refuses a second booking.
 */
async function readBookedCall(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
): Promise<string | undefined> {
  const lead = await readLeadData(db, tenantId, leadId, "ai-audit.notify");
  const appointmentId = typeof lead.calendar_appointment_id === "string" ? lead.calendar_appointment_id.trim() : "";
  if (!appointmentId) return undefined;
  try {
    const res = await db
      .from("call_appointments")
      .select("scheduled_for,status,calendar_status")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("id", appointmentId)
      .maybeSingle();
    if (res.error) {
      console.error("[ai-audit.notify] appointment read:", res.error.message);
      return undefined;
    }
    return bookedCallFromAppointment(res.data as Parameters<typeof bookedCallFromAppointment>[0]);
  } catch (err) {
    console.error("[ai-audit.notify] appointment read threw:", err);
    return undefined;
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
  // Revenue and Bottleneck (CC 2026-10-16). Step 1 asks neither, so they come
  // from the lead's own row: a returning visitor matched onto an existing lead
  // (a booked-call form, an earlier audit) already carries both. What they just
  // typed wins over what the row held. A lead with neither gets neither line.
  const facts = alertLeadFactLines({ ...(await readLeadData(db, tenantId, leadId)), ...answers });

  const lines = [
    "🟢 New inbound — OASIS AI audit started",
    "",
    `${name}${company ? ` · ${company}` : ""}`,
    email ? `✉️ ${email}` : "",
    website ? `🔗 ${website}` : "",
    ...facts,
    "",
    // Derived from the seed, so the alert cannot drift out of step with
    // the funnel the way the hardcoded version did.
    `Step 1 of ${AI_AUDIT_STEP_COUNT} complete. Score arrives if they finish.`,
    `📅 <b>Meeting:</b> unbooked - needs follow-up`,
    `<a href="${pipelineLeadUrl(leadId)}">Open the lead in Command Center →</a>`,
  ].filter(Boolean);

  // The sales desk: a lead submitted on oasisai.work is for CC AND Adon. The
  // audience is chosen from the workspace (lib/notify/alert-route.ts), not here.
  const r = await pushWorkspaceAlert(tenantId, lines.join("\n"), { desk: "sales" });
  if (!r.delivered) {
    console.error("[ai-audit.started] telegram:", r.outcome);
    // The step-0 alert matters MORE than the completion one, not less: it
    // fires for someone who filled in their details and then bounced at
    // step 2. There is no welcome email and no score for that visitor, so
    // this alert is the only thing that exists. Losing it silently loses
    // the lead entirely.
    await recordAlertFailure({
      db, tenantId, leadId,
      source: AI_AUDIT_ALERT_SOURCE,
      label: "AI audit (started)",
      reason: r.outcome,
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

/**
 * The links the confirmation email carries beyond its words.
 *
 * bookingUrl: a signed, personal link back to the calendar
 *   (/f/oasis-ai-cc/ai-audit/<token>?book=1). The visitor may have closed the
 *   tab before picking a time; without this the email only pointed at a page
 *   they no longer have. Omitted when the signing key is unset (dev).
 *
 * communityUrl: the free community, tracked through /go/community. It is an
 *   INVITATION, so it rides this transactional email only when email marketing
 *   consent was ticked for this exact address (marketingSendAllowed). A visitor
 *   who declined still gets their confirmation, just not the invitation.
 *
 * Neither can fail the delivery: each is best-effort and the email goes without it.
 */
async function buildWelcomeLinks(input: {
  db: SupabaseClient;
  tenantId: string;
  formId: string;
  leadId: string;
  toEmail: string;
}): Promise<WelcomeLinks> {
  const links: WelcomeLinks = {};
  try {
    const token = signFormLink({ tenant: AI_AUDIT_TENANT_SLUG, form_id: input.formId, lead_id: input.leadId });
    if (token) {
      links.bookingUrl = `${buildResumeUrl({
        appBaseUrl: SITE_ORIGIN,
        tenantSlug: AI_AUDIT_TENANT_SLUG,
        formSlug: AI_AUDIT_SLUG,
        token,
      })}?book=1`;
    }
  } catch (err) {
    console.error("[ai-audit.notify] booking link not minted:", err);
  }
  if (input.toEmail) {
    try {
      const verdict = await marketingSendAllowed(input.db, {
        tenantId: input.tenantId,
        channel: "email",
        destination: input.toEmail,
      });
      if (verdict.allow) links.communityUrl = `${SITE_ORIGIN}/go/community?from=audit_email`;
    } catch (err) {
      console.error("[ai-audit.notify] consent check failed, no community line:", err);
    }
  }
  return links;
}

export async function ensureAiAuditSubmissionDelivery(
  input: AiAuditNotifyInput,
): Promise<{ emailNote: string; salesEventOk: boolean; bookedCall?: string }> {
  const { db, tenantId, formId, leadId, answers, score } = input;
  // Booked before finishing? Then the event, the email and the alert say so.
  const bookedCall = await readBookedCall(db, tenantId, leadId);
  const salesEvent = await ensureAiAuditSalesEvent({
    db,
    tenantId,
    formId,
    leadId,
    event: "completed",
    score,
    bookedCall,
  });
  if (!salesEvent.ok) {
    console.error("[ai-audit.notify] Sales event:", salesEvent.error);
  }

  const toEmail = String(answers.email ?? "").trim().toLowerCase();
  const { subject, body } = composeAiAuditWelcome(
    answers,
    bookedCall ? {} : await buildWelcomeLinks({ db, tenantId, formId, leadId, toEmail }),
    { booked: Boolean(bookedCall) },
  );
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
  return { emailNote, salesEventOk: salesEvent.ok, bookedCall };
}

export async function notifyAiAuditSubmission(
  input: AiAuditNotifyInput,
): Promise<void> {
  const { db, tenantId, leadId, answers, score } = input;
  const toEmail = String(answers.email ?? "").trim().toLowerCase();
  // Both writes use deterministic keys. A repeat submission repairs a missing
  // event or queue row without duplicating either one.
  const { emailNote, bookedCall } = await ensureAiAuditSubmissionDelivery(input);

  const alert = buildAiAuditAlert(answers, score, {
    bookedCall,
    emailStatus: emailNote,
    inboxUrl: toEmail
      ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(toEmail)}`
      : "",
    leadUrl: pipelineLeadUrl(leadId),
  });

  // The sales desk (CC + Adon), chosen from the workspace in alert-route.ts.
  // pushWorkspaceAlert never throws, so there is no catch to forget here.
  const tg = await pushWorkspaceAlert(tenantId, alert, { desk: "sales" });

  if (!tg.delivered) {
    console.error("[ai-audit.notify] telegram:", tg.outcome);
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
      reason: tg.outcome,
      extra: `The welcome email was ${emailNote}.`,
      tag: "ai-audit.notify",
    });
  }
}
