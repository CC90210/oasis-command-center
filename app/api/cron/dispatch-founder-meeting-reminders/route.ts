import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { bookingMeetRoomDeps } from "@/lib/booking/meet-room";
import { sendGmailAsOperator } from "@/lib/integrations/gmail-oauth-send";
import { sendOasisSharedGmail } from "@/lib/integrations/oasis-shared-gmail-send";
import { quoCredentialsOrNull, quoSender, quoStopIntakeConnected, sendQuoSms } from "@/lib/integrations/quo";
import { smsConsentStillGiven } from "@/lib/booking/sms-consent";
import { isDryRun } from "@/lib/integrations/send-mode";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { checkTcpaWindow, dispatchByTcpaWindow, nextTcpaWindowStart } from "@/lib/tcpa-window";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { memberStanding, type MemberStanding } from "@/lib/team";
import { RETIRED_TENANT_ID_LIST } from "@/lib/tenant/retired";
import { countSegments } from "@/lib/sms-segments";
import { watchFounderMeetings, type WatchResult } from "@/lib/booking/meeting-watch";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import { SITE_ORIGIN } from "@/lib/marketing/routes";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { clipAndEscape, escapeTelegramHtml } from "@/lib/notify/telegram-format";
import {
  backfillFounderMeetingNotifications,
  reconcileFounderMeetingSagas,
  type FounderMeetingNotificationBackfillResult,
  type FounderMeetingReconciliationResult,
} from "@/lib/website-sales-founder-meeting";
import {
  buildFounderHostHeadsUp,
  buildFounderMeetingMessages,
  clampSmsBody,
  isKnownReminderTier,
  meetingNotificationDecision,
  minutesUntilMeeting,
  reminderTierStillValid,
  withSmsFooter,
} from "@/lib/website-sales-meeting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 15 * 60_000;
const APPOINTMENT_LEASE_MS = STALE_CLAIM_MS;

type NotificationRow = {
  id: string;
  tenant_id: string;
  appointment_id: string;
  lead_id: string;
  kind:
    | "confirmation"
    | "reminder_1440" | "reminder_60" | "reminder_30" | "reminder_15" | "reminder_5" | "ten_minute"
    | "host_15" | "host_guest_waiting" | "no_show_rebook" | "no_show_followup";
  reminder_minutes_before: number | null;
  channel: "email" | "sms";
  due_at: string;
  recipient: string;
  sender_user_id: string;
  subject: string | null;
  body: string;
  attempts: number;
  appointment_revision: number;
  attempt_token: string;
  provider?: string | null;
  provider_receipt?: string | null;
  sent_at?: string | null;
  tracking_attempts?: number;
};

type AppointmentState = {
  id: string;
  scheduled_for: string;
  status: string;
  calendar_status: string;
  workflow_status: string;
  revision: number;
  sms_consent: number | boolean;
  client_phone_snapshot: string | null;
  client_email_snapshot: string | null;
  client_name_snapshot: string | null;
  company_snapshot: string | null;
  client_agenda: string | null;
  offer_label: string | null;
  duration_minutes: number | null;
  timezone: string;
  google_meet_link: string | null;
  organizer_email_snapshot: string | null;
  pending_started_at: string | null;
  updated_at: string;
  notification_lease_token: string | null;
  notification_lease_expires_at: string | null;
};

type Db = ReturnType<typeof getServiceSupabase>;

class DeliveryStateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryStateUnknownError";
  }
}

async function setHealth(input: { status: "healthy" | "degraded"; processed: number; failed: number; error?: string }) {
  const now = new Date().toISOString();
  await getTursoClient().execute({
    sql: `INSERT INTO website_sales_meeting_worker_health
            (id,status,last_run_at,processed,failed,last_error,updated_at)
          VALUES (1,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            status=excluded.status,last_run_at=excluded.last_run_at,
            processed=excluded.processed,failed=excluded.failed,
            last_error=excluded.last_error,updated_at=excluded.updated_at`,
    args: [input.status, now, input.processed, input.failed, input.error?.slice(0, 500) || null, now],
  });
}

async function mark(
  db: Db,
  row: NotificationRow,
  status: "pending" | "sent" | "skipped" | "failed",
  input: {
    provider?: string;
    receipt?: string;
    error?: string;
    incrementAttempt?: boolean;
    subject?: string | null;
    body?: string;
    sentAt?: string;
  } = {},
) {
  const attempts = row.attempts + (input.incrementAttempt ? 1 : 0);
  const result = await db.from("website_sales_meeting_notifications").update({
    status,
    attempts,
    provider: input.provider || null,
    provider_receipt: input.receipt || null,
    last_error: input.error?.slice(0, 500) || null,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    claimed_at: null,
    sent_at: status === "sent" ? input.sentAt || new Date().toISOString() : null,
    ...(status === "sent" ? {
      tracking_status: "pending",
      tracking_last_error: null,
      tracked_at: null,
    } : {}),
    updated_at: new Date().toISOString(),
  })
    .eq("tenant_id", row.tenant_id)
    .eq("appointment_id", row.appointment_id)
    .eq("id", row.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
  if (result.error) throw new Error(`notification_status_write_failed:${result.error.message}`);
  if (!result.data) throw new Error("notification_status_conflict");
}

/** Back to pending at a later due time (a day-before text held to the lead's daytime). */
async function deferRow(db: Db, row: NotificationRow, dueAt: string, reason: string) {
  const result = await db.from("website_sales_meeting_notifications").update({
    status: "pending",
    due_at: dueAt,
    claimed_at: null,
    last_error: reason,
    updated_at: new Date().toISOString(),
  })
    .eq("tenant_id", row.tenant_id)
    .eq("appointment_id", row.appointment_id)
    .eq("id", row.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
  if (result.error) throw new Error(`notification_status_write_failed:${result.error.message}`);
  if (!result.data) throw new Error("notification_status_conflict");
}

async function retryOrFail(db: Db, row: NotificationRow, reason: string) {
  const nextAttempts = row.attempts + 1;
  await mark(db, row, nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending", {
    error: reason,
    incrementAttempt: true,
  });
}

/** Sender standing read once per (tenant, sender) per pass, and the email rows
 *  withheld from a deactivated sender this pass (alerted once, after the loop). */
type SenderPass = {
  standings: Map<string, MemberStanding>;
  withheld: NotificationRow[];
};

/**
 * Whether an EMAIL row's sender may still send as themselves -- mirrors
 * app/api/cron/dispatch-scheduled-sends senderMayDispatch. A founder-meeting
 * email goes out from the host's own Gmail, so a row queued before the host
 * was deactivated must not fire. Returns false once the row has been marked.
 * SMS rows never come here: they leave from OASIS's Quo number.
 *
 *  - deactivated -> permanent fail `sender_deactivated`; retrying cannot bring
 *    the host back. Collected for the pass's operator alert.
 *  - not_member -> today's behaviour: sendGmailAsOperator's own tenant-scoped
 *    mailbox lookup decides.
 *  - read error -> the normal retry path, never a send. Not cached, so the
 *    sender's next row asks again.
 */
async function senderMayDispatch(db: Db, row: NotificationRow, pass: SenderPass): Promise<boolean> {
  const key = `${row.tenant_id}:${row.sender_user_id}`;
  let standing = pass.standings.get(key);
  if (!standing) {
    try {
      standing = (await memberStanding(row.tenant_id, row.sender_user_id)).standing;
    } catch (error) {
      console.error("[founder-meeting-reminders] sender standing check failed", {
        id: row.id,
        tenant: row.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
      await retryOrFail(db, row, "sender_standing_check_failed");
      return false;
    }
    pass.standings.set(key, standing);
  }
  if (standing === "deactivated") {
    console.warn("[founder-meeting-reminders] sender deactivated", { id: row.id, tenant: row.tenant_id });
    await mark(db, row, "failed", { error: "sender_deactivated", incrementAttempt: true });
    pass.withheld.push(row);
    return false;
  }
  return true;
}

/** One card per tenant per pass (founder meetings are OASIS-only, so in
 *  practice one), refreshed rather than re-paged while it stays open. */
async function alertWithheldReminders(withheld: NotificationRow[]): Promise<void> {
  const byTenant = new Map<string, NotificationRow[]>();
  for (const row of withheld) byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) || []), row]);
  for (const [tenantId, rows] of byTenant) {
    const appointmentIds = [...new Set(rows.map((row) => row.appointment_id))];
    await writeAgentAlert({
      tenantId,
      alertType: "founder_meeting_sender_deactivated",
      severity: "warn",
      title: "Founder-meeting reminder withheld: host deactivated",
      body: `${rows.length} reminder email(s) were not sent because the meeting host has been deactivated. ` +
        `Mark each meeting no-show and book a new audit with an active host. Appointments: ${appointmentIds.join(", ")}`,
      payload: {
        notification_ids: rows.map((row) => row.id),
        appointment_ids: appointmentIds,
        sender_user_ids: [...new Set(rows.map((row) => row.sender_user_id))],
      },
      telegramOncePerOpen: true,
    });
  }
}

async function acquireAppointmentLease(
  db: Db,
  row: NotificationRow,
  appointment: AppointmentState,
  now: string,
  /** The meeting state the row is for: a live meeting (reminders) or a closed no-show (its rebook messages). */
  expected: { status: string; workflowStatus: string } = { status: "scheduled", workflowStatus: "active" },
): Promise<string | null> {
  const currentToken = appointment.notification_lease_token;
  const currentExpiry = appointment.notification_lease_expires_at;
  const expiryEpoch = Date.parse(currentExpiry || "");
  if (currentToken && Number.isFinite(expiryEpoch) && expiryEpoch > Date.parse(now)) return null;

  const token = randomUUID();
  let query = db.from("call_appointments")
    .update({
      notification_lease_token: token,
      notification_lease_expires_at: new Date(Date.parse(now) + APPOINTMENT_LEASE_MS).toISOString(),
      updated_at: now,
    })
    .eq("tenant_id", row.tenant_id)
    .eq("lead_id", row.lead_id)
    .eq("id", row.appointment_id)
    .eq("status", expected.status)
    .eq("workflow_status", expected.workflowStatus)
    .eq("calendar_status", "verified")
    .eq("revision", row.appointment_revision);
  query = currentToken
    ? query.eq("notification_lease_token", currentToken)
    : query.is("notification_lease_token", null);
  query = currentExpiry
    ? query.eq("notification_lease_expires_at", currentExpiry)
    : query.is("notification_lease_expires_at", null);
  const result = await query.select("id").maybeSingle();
  if (result.error) throw new Error(`appointment_notification_lease_failed:${result.error.message}`);
  return result.data ? token : null;
}

async function releaseAppointmentLease(db: Db, row: NotificationRow, token: string): Promise<void> {
  const result = await db.from("call_appointments")
    .update({
      notification_lease_token: null,
      notification_lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", row.tenant_id)
    .eq("id", row.appointment_id)
    .eq("notification_lease_token", token)
    .select("id")
    .maybeSingle();
  if (result.error) throw new Error(`appointment_notification_lease_release_failed:${result.error.message}`);
  if (!result.data) throw new Error("appointment_notification_lease_release_conflict");
}

async function recordTouch(
  db: Db,
  row: NotificationRow,
  provider: string,
  receipt: string,
  sentAt: string,
) {
  const inserted = await db.from("lead_interactions").insert({
    tenant_id: row.tenant_id,
    lead_id: row.lead_id,
    type: row.channel === "email" ? "email_sent" : "sms_sent",
    channel: row.channel,
    direction: "outbound",
    agent_source: "founder_meeting_reminder",
    to_email: row.channel === "email" ? row.recipient : null,
    to_phone: row.channel === "sms" ? row.recipient : null,
    subject: row.subject,
    content: row.channel === "email" ? row.body : null,
    content_preview: row.body.slice(0, 1024),
    actor_user_id: row.sender_user_id,
    created_at: sentAt,
    metadata: {
      appointment_id: row.appointment_id,
      notification_id: row.id,
      appointment_revision: row.appointment_revision,
      reminder_kind: row.kind,
      reminder_minutes_before: row.reminder_minutes_before,
      attempt_token: row.attempt_token,
      provider,
      provider_receipt: receipt,
    },
  });
  if (
    inserted.error &&
    !String(inserted.error.message).toLowerCase().includes("unique")
  ) {
    throw new Error(`reminder_interaction_write_failed:${inserted.error.message}`);
  }
  await persistCanonicalLeadTouch(db, {
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    occurredAt: sentAt,
  });
}

async function markTrackingComplete(db: Db, row: NotificationRow): Promise<void> {
  const now = new Date().toISOString();
  const result = await db.from("website_sales_meeting_notifications").update({
    tracking_status: "tracked",
    tracking_last_error: null,
    tracked_at: now,
    updated_at: now,
  }).eq("tenant_id", row.tenant_id)
    .eq("id", row.id)
    .eq("status", "sent")
    .eq("tracking_status", "pending")
    .select("id")
    .maybeSingle();
  if (result.error || !result.data) {
    throw new Error(`reminder_tracking_status_write_failed:${result.error?.message || "row_changed"}`);
  }
}

async function markTrackingError(db: Db, row: NotificationRow, error: string): Promise<void> {
  const result = await db.from("website_sales_meeting_notifications").update({
    tracking_attempts: Number(row.tracking_attempts || 0) + 1,
    tracking_last_error: error.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", row.tenant_id)
    .eq("id", row.id)
    .eq("status", "sent")
    .eq("tracking_status", "pending")
    .select("id")
    .maybeSingle();
  if (result.error || !result.data) {
    throw new Error(`reminder_tracking_error_write_failed:${result.error?.message || "row_changed"}`);
  }
}

async function persistReminderTracking(db: Db, row: NotificationRow): Promise<void> {
  if (!row.provider || !row.provider_receipt || !row.sent_at || !row.attempt_token) {
    throw new Error("reminder_tracking_receipt_missing");
  }
  // Mail to the founder is not contact with the lead: no timeline "email
  // sent", no Last Touch, no outreach count (Codex review of #774).
  if (!isHostKind(row.kind)) await recordTouch(db, row, row.provider, row.provider_receipt, row.sent_at);
  await markTrackingComplete(db, row);
}

/** Mail to OASIS's own founder about a meeting (heads-up, lead waiting), never to the lead. */
function isHostKind(kind: string): boolean {
  return kind === "host_15" || kind === "host_guest_waiting";
}

function isNoShowKind(kind: string): boolean {
  return kind === "no_show_rebook" || kind === "no_show_followup";
}

/**
 * Whether a row queued after the start still goes out.
 *  - host_guest_waiting: while the meeting is still on the books (not closed
 *    or moved), within an hour of its start; later, it would only be noise.
 *  - no_show_rebook / no_show_followup: while the meeting is still the closed
 *    no-show they were queued for (a rebook moves it back to "scheduled"), and
 *    the lead is still at Founder Meeting (not lost, not further on).
 */
async function afterStartRowStillDue(db: Db, row: NotificationRow, appointment: AppointmentState): Promise<string> {
  if (Number(appointment.revision) !== Number(row.appointment_revision)) return "meeting_moved";
  if (row.kind === "host_guest_waiting") {
    if (appointment.status !== "scheduled" || appointment.workflow_status !== "active") return "meeting_closed";
    if (Date.now() - Date.parse(appointment.scheduled_for) > 60 * 60_000) return "meeting_window_passed";
    return "send";
  }
  if (appointment.status === "scheduled" && appointment.workflow_status === "active") {
    // Not closed out yet (the watcher queues before it closes): wait, but not
    // past the watcher's own window, after which nothing will close it.
    const startedMs = Date.parse(appointment.scheduled_for);
    if (Number.isFinite(startedMs) && startedMs <= Date.now() && Date.now() - startedMs < 48 * 3_600_000) return "hold";
    return "no_show_never_closed";
  }
  if (appointment.status !== "no_answer" || appointment.workflow_status !== "no_show") return "meeting_rebooked_or_closed";
  const lead = await db.from("tenant_records")
    .select("data")
    .eq("tenant_id", row.tenant_id)
    .eq("entity_type", "lead")
    .eq("id", row.lead_id)
    .maybeSingle();
  if (lead.error) throw new Error(`no_show_lead_read_failed:${lead.error.message}`);
  const raw = (lead.data as { data?: unknown } | null)?.data;
  let data: Record<string, unknown> = {};
  try {
    data = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw as Record<string, unknown>) ?? {});
  } catch {
    data = {};
  }
  if (data.stage !== "founder_meeting_booked") return "lead_moved_on";
  if (data.calendar_appointment_id !== row.appointment_id) return "lead_has_other_meeting";
  return "send";
}

async function processRow(
  db: Db,
  row: NotificationRow,
  senderPass: SenderPass,
): Promise<"sent" | "skipped" | "failed" | "held"> {
  const appointmentResult = await db.from("call_appointments")
    .select("id,scheduled_for,status,calendar_status,workflow_status,revision,sms_consent,client_phone_snapshot,client_email_snapshot,client_name_snapshot,company_snapshot,client_agenda,offer_label,duration_minutes,timezone,google_meet_link,organizer_email_snapshot,pending_started_at,updated_at,notification_lease_token,notification_lease_expires_at")
    .eq("tenant_id", row.tenant_id)
    .eq("id", row.appointment_id)
    .maybeSingle();
  if (appointmentResult.error) {
    await retryOrFail(db, row, `appointment_lookup_failed:${appointmentResult.error.message}`);
    return "failed";
  }
  const appointment = appointmentResult.data as AppointmentState | null;
  if (!appointment) {
    await mark(db, row, "skipped", { error: "appointment_missing" });
    return "skipped";
  }
  const decisionAt = new Date().toISOString();
  // After the start (lib/booking/meeting-watch.ts): the founder's "lead is
  // waiting" note, and a missed meeting's rebook link and follow-ups. Each has
  // its own rule, and each still takes the appointment lease (for the state it
  // expects), so a rebook landing mid-send waits for it (Codex review).
  const afterStart = row.kind === "host_guest_waiting" || isNoShowKind(row.kind);
  if (afterStart) {
    const verdict = await afterStartRowStillDue(db, row, appointment);
    if (verdict === "hold") {
      // Queued by the watcher before the meeting is closed out: it goes once
      // the close lands (the watcher retries a close that failed).
      await mark(db, row, "pending", { error: "waiting_for_no_show_close" });
      return "held";
    }
    if (verdict !== "send") {
      await mark(db, row, "skipped", { error: verdict });
      return "skipped";
    }
  } else {
    const decision = meetingNotificationDecision({
      workflowStatus: appointment.workflow_status,
      appointmentStatus: appointment.status,
      calendarStatus: appointment.calendar_status,
      appointmentRevision: Number(appointment.revision),
      notificationRevision: Number(row.appointment_revision),
      meetingAt: appointment.scheduled_for,
      now: decisionAt,
      transitionStartedAt: appointment.pending_started_at,
    });
    if (decision === "hold") {
      await mark(db, row, "pending", { error: "waiting_for_lifecycle_transition" });
      return "held";
    }
    if (decision === "skip") {
      await mark(db, row, "skipped", { error: "appointment_no_longer_sendable" });
      return "skipped";
    }
  }

  const leaseToken = await acquireAppointmentLease(
    db,
    row,
    appointment,
    decisionAt,
    isNoShowKind(row.kind) ? { status: "no_answer", workflowStatus: "no_show" } : undefined,
  );
  if (!leaseToken) {
    await mark(db, row, "pending", { error: "appointment_delivery_or_transition_in_progress" });
    return "held";
  }

  let retainLeaseUntilRecovery = false;
  try {
    let deliveryRow = row;
    if (row.reminder_minutes_before != null) {
      const tier = Number(row.reminder_minutes_before);
      const actualMinutes = minutesUntilMeeting(appointment.scheduled_for, new Date().toISOString());
      if (actualMinutes <= 0) {
        await mark(db, row, "skipped", { error: "meeting_already_started" });
        return "skipped";
      }
      if (!isKnownReminderTier(tier)) {
        await mark(db, row, "skipped", { error: "reminder_tier_invalid" });
        return "skipped";
      }
      if (row.kind === "host_15") {
        // The founder's heads-up: who, company, how to reach them, the room.
        const heads = buildFounderHostHeadsUp({
          contactName: appointment.client_name_snapshot,
          company: appointment.company_snapshot,
          email: appointment.client_email_snapshot,
          phone: appointment.client_phone_snapshot,
          meetingAt: appointment.scheduled_for,
          timezone: appointment.timezone,
          meetLink: appointment.google_meet_link || "",
          clientAgenda: appointment.client_agenda || "Not given.",
          offerLabel: appointment.offer_label,
          leadId: row.lead_id,
          minutesBefore: actualMinutes,
        });
        deliveryRow = { ...row, subject: heads.subject, body: heads.body };
      } else {
        if (!reminderTierStillValid(tier, actualMinutes, row.channel)) {
          await mark(db, row, "skipped", { error: "reminder_tier_superseded" });
          return "skipped";
        }
        const messages = buildFounderMeetingMessages({
          company: appointment.company_snapshot,
          contactName: appointment.client_name_snapshot,
          meetingAt: appointment.scheduled_for,
          timezone: appointment.timezone,
          meetLink: appointment.google_meet_link || "",
          clientAgenda: appointment.client_agenda || "Review your current website and next steps.",
          durationMinutes: appointment.duration_minutes ?? undefined,
          offerLabel: appointment.offer_label,
          reminderMinutesBefore: actualMinutes,
        });
        deliveryRow = {
          ...row,
          subject: messages.reminder.subject,
          body: row.channel === "email" ? messages.reminder.body : messages.reminder.sms,
        };
      }
    }

    let provider = "";
    let receipt = "";
    if (row.channel === "email") {
      if (!(await senderMayDispatch(db, row, senderPass))) return "failed";
      if (!appointment.organizer_email_snapshot) {
        await mark(db, row, "failed", { error: "approved_sender_missing", incrementAttempt: true });
        return "failed";
      }
      // Derived from the row's tenant, fail-closed. Founder meetings are an
      // OASIS product, but the brand is resolved rather than assumed so this
      // stays correct if the surface is ever offered to another tenant -- and
      // so a mapping gap surfaces as a failed row rather than as a reminder
      // signed by the wrong company.
      const reminderBrand = brandForTenant({ tenantId: row.tenant_id });
      if (!reminderBrand) {
        await mark(db, row, "failed", {
          error: "no_sending_brand_for_tenant",
          incrementAttempt: true,
        });
        return "failed";
      }
      const subject = deliveryRow.subject || "Your OASIS meeting reminder";
      if (isHostKind(row.kind)) {
        // Mail to OASIS's own founder, not a lead: always the shared mailbox as
        // an internal team alert, so an opt-out filed against a founder's
        // address cannot silence it (Codex review of #774).
        const shared = await sendOasisSharedGmail({
          tenantId: row.tenant_id,
          to: row.recipient,
          subject,
          body: deliveryRow.body,
          idempotencyKey: row.attempt_token,
          internalAlert: true,
        });
        if (!shared.ok) {
          if (shared.reason === "delivery_unknown") {
            await mark(db, row, "failed", { error: `shared:${shared.reason}:${shared.error}`, incrementAttempt: true });
          } else {
            await retryOrFail(db, row, `shared:${shared.reason}:${shared.error}`);
          }
          return "failed";
        }
        provider = shared.provider;
        receipt = shared.gmail_message_id || row.attempt_token;
      } else {
        const sent = await sendGmailAsOperator({
          tenantId: row.tenant_id,
          userId: row.sender_user_id,
          to: row.recipient,
          subject,
          body: deliveryRow.body,
          expectedFromAddress: appointment.organizer_email_snapshot,
          idempotencyKey: row.attempt_token,
          brand: reminderBrand,
        });
        if (sent.ok) {
          provider = sent.provider;
          receipt = sent.gmail_message_id;
        } else if (sent.reason === "not_connected" || sent.reason === "refresh_failed") {
          // The host's own Gmail login is not connected: every reminder from
          // 2026-09-04 to 2026-10-28 failed right here ("no gmail_oauth bundle")
          // and nobody heard. OASIS's shared mailbox sends it instead.
          const shared = await sendOasisSharedGmail({
            tenantId: row.tenant_id,
            to: row.recipient,
            subject,
            body: deliveryRow.body,
            idempotencyKey: row.attempt_token,
            // A lead answering "can we move it?" reaches the host, as from the
            // host's own Gmail (Codex review of #774).
            replyTo: appointment.organizer_email_snapshot,
          });
          if (!shared.ok) {
            const detail = `operator:${sent.reason}; shared:${shared.reason}:${shared.error}`;
            if (shared.reason === "suppressed") {
              await mark(db, row, "skipped", { error: "recipient_suppressed" });
              return "skipped";
            }
            if (shared.reason === "delivery_unknown") {
              await mark(db, row, "failed", { error: detail, incrementAttempt: true });
            } else {
              await retryOrFail(db, row, detail);
            }
            return "failed";
          }
          provider = shared.provider;
          receipt = shared.gmail_message_id || row.attempt_token;
        } else {
          if (sent.reason === "sender_mismatch" || sent.reason === "delivery_unknown") {
            await mark(db, row, "failed", { error: `${sent.reason}:${sent.error}`, incrementAttempt: true });
          } else {
            await retryOrFail(db, row, `${sent.reason}:${sent.error}`);
          }
          return "failed";
        }
      }
    } else {
      if (!appointment.sms_consent || appointment.client_phone_snapshot !== row.recipient) {
        await mark(db, row, "skipped", { error: "sms_consent_missing_or_recipient_changed" });
        return "skipped";
      }
      // The snapshot is from booking: a later "no" in the consent ledger wins.
      const consent = await smsConsentStillGiven(db, row.tenant_id, row.recipient);
      if (consent === "no") {
        await mark(db, row, "skipped", { error: "sms_consent_withdrawn" });
        return "skipped";
      }
      if (consent === "unknown") {
        await retryOrFail(db, row, "sms_consent_check_failed");
        return "failed";
      }
      // Quiet hours, by the real time left before the call. Inside the last
      // hour a text always goes out: the lead picked that time, and one held
      // to 8 am would be for a call already over. Further out (the day-before
      // text, a confirmation for a call days away) it keeps the lead's
      // daytime: moved to the next 8 am-9 pm opening while that is still more
      // than an hour ahead, else left to the email (Codex review of #774).
      const minutesToCall = (Date.parse(appointment.scheduled_for) - Date.now()) / 60_000;
      if (isNoShowKind(row.kind) || minutesToCall > 60) {
        const quietHours = checkTcpaWindow(row.recipient, new Date());
        if (!quietHours.usedFallback && !quietHours.withinWindow) {
          const opens = nextTcpaWindowStart(row.recipient, new Date());
          // A missed meeting's rebook text has no call to beat: it always waits for daytime.
          if (isNoShowKind(row.kind) || Date.parse(appointment.scheduled_for) - opens.getTime() > 60 * 60_000) {
            await deferRow(db, row, opens.toISOString(), "held_for_recipient_daytime");
            return "held";
          }
        }
        const windowDisposition = await dispatchByTcpaWindow(quietHours, {
          skip: async (error) => {
            await mark(db, row, "skipped", { error });
            return "skipped" as const;
          },
          send: () => "send" as const,
        });
        if (windowDisposition === "skipped") return "skipped";
      }
      const priorSms = await db.from("website_sales_meeting_notifications")
        .select("id")
        .eq("tenant_id", row.tenant_id)
        .eq("channel", "sms")
        .eq("recipient", row.recipient)
        .eq("status", "sent")
        .limit(1);
      if (priorSms.error) {
        await retryOrFail(db, row, `sms_conversation_lookup_failed:${priorSms.error.message}`);
        return "failed";
      }
      const footed = withSmsFooter(deliveryRow.body, { firstInConversation: (priorSms.data || []).length === 0 });
      if (isNoShowKind(row.kind)) {
        // The signed rebook link is the whole point of this text and runs to
        // ~280 characters: it is sent whole in up to four segments, never
        // shortened to the meeting-link fallback that would drop it (Codex
        // review). Longer than that, the email carries it.
        if (countSegments(footed) > 4) {
          await mark(db, row, "skipped", { error: "sms_rebook_text_too_long" });
          return "skipped";
        }
        deliveryRow = { ...deliveryRow, body: footed };
      } else {
        deliveryRow = { ...deliveryRow, body: clampSmsBody(footed) };
      }
      // OASIS texts through Quo since 2026-10-26 (Twilio broke). Its own
      // switches and the workspace's STOP list are re-checked in sendQuoSms.
      // A STOP texted back to the Quo number is not read by OASIS yet
      // (lib/integrations/quo.ts), and an automated text must honour one. So
      // reminders are texted only once that intake is connected; until then
      // the email carries them (Codex review of #774).
      if (!quoStopIntakeConnected()) {
        await mark(db, row, "skipped", { error: "quo_stop_intake_not_connected" });
        return "skipped";
      }
      const quo = await quoCredentialsOrNull(row.tenant_id);
      if (!quo) {
        await mark(db, row, "skipped", { error: "oasis_sms_not_configured" });
        return "skipped";
      }
      if (isDryRun("quo")) {
        await mark(db, row, "skipped", { error: "quo_live_send_disabled" });
        return "skipped";
      }
      // Which number it leaves from is settled BEFORE anything is sent: a
      // failed lookup sent nothing, so it retries instead of dropping the text.
      const sender = await quoSender(quo);
      if (!sender.ok) {
        await retryOrFail(db, row, `quo_sender:${sender.code}:${sender.reason}`);
        return "failed";
      }
      const sent = await sendQuoSms({ ...quo, fromNumber: sender.number }, { to: row.recipient, text: deliveryRow.body });
      if (!sent.ok) {
        const detail = `${sent.code}:${sent.reason}`;
        if (["recipient_opted_out", "invalid_recipient", "quo_switched_off", "live_send_disabled", "tenant_retired"].includes(sent.code)) {
          await mark(db, row, "skipped", { error: detail });
          return "skipped";
        }
        if (sent.code === "quo_refused" && sent.status === 429) {
          // Quo said "slow down": nothing was sent, so the next run (a minute
          // on) tries again, within MAX_ATTEMPTS (Codex review of #774).
          await retryOrFail(db, row, detail);
          return "failed";
        }
        if (sent.code === "quo_unreachable" || sent.code === "quo_unexpected" || sent.code === "quo_refused") {
          // Unknown or refused by Quo (a destination the number may not text,
          // like an international one): never retried into a double text.
          await mark(db, row, "failed", { error: detail, incrementAttempt: true });
          return "failed";
        }
        await retryOrFail(db, row, detail);
        return "failed";
      }
      provider = "quo";
      receipt = sent.id;
    }

    const sentAt = new Date().toISOString();
    try {
      await mark(db, row, "sent", {
        provider,
        receipt,
        incrementAttempt: true,
        subject: deliveryRow.subject,
        body: deliveryRow.body,
        sentAt,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "notification_status_write_failed";
      retainLeaseUntilRecovery = true;
      throw new DeliveryStateUnknownError(`provider_accepted_but_status_unknown:${detail}`);
    }
    try {
      await persistReminderTracking(db, {
        ...deliveryRow,
        provider,
        provider_receipt: receipt,
        sent_at: sentAt,
        tracking_attempts: 0,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "reminder_tracking_failed";
      console.error("[founder-meeting-reminders] sent but tracking failed", row.id, detail);
      await markTrackingError(db, { ...row, tracking_attempts: 0 }, detail).catch((trackingError) => {
        console.error("[founder-meeting-reminders] tracking-error persistence failed", row.id, trackingError);
      });
    }
    return "sent";
  } finally {
    if (leaseToken && !retainLeaseUntilRecovery) {
      try {
        await releaseAppointmentLease(db, row, leaseToken);
      } catch (error) {
        console.error("[founder-meeting-reminders] appointment lease release failed", row.id, error);
      }
    }
  }
}

/**
 * Every reminder that ended "failed" in this run, told to the founder at once
 * (CC, 2026-10-28: two months of reminders failed and nobody heard). One alert
 * per run that had failures, through the same route as booking alerts, which
 * emails the founder when Telegram refuses and caps itself per hour.
 */
async function alertFailedReminders(db: Db, runStartedAt: string): Promise<void> {
  const failed = await db.from("website_sales_meeting_notifications")
    .select("tenant_id,lead_id,kind,channel,last_error")
    .eq("status", "failed")
    .gte("updated_at", runStartedAt)
    .order("updated_at", { ascending: true })
    .limit(20);
  if (failed.error || !failed.data?.length) return;
  const byTenant = new Map<string, Array<{ lead_id: string; kind: string; channel: string; last_error: string | null }>>();
  for (const row of failed.data as Array<{ tenant_id: string; lead_id: string; kind: string; channel: string; last_error: string | null }>) {
    byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) || []), row]);
  }
  for (const [tenantId, rows] of byTenant) {
    const lines = rows.slice(0, 5).map((row) =>
      `- ${escapeTelegramHtml(row.kind)} ${row.channel === "sms" ? "text" : "email"}: ${clipAndEscape(row.last_error || "unknown", 140)} <a href="${pipelineLeadUrl(row.lead_id)}">lead</a>`,
    );
    await pushWorkspaceAlert(
      tenantId,
      [`<b>Meeting reminder failed</b>`, `${rows.length} reminder(s) could not be sent:`, ...lines].join("\n"),
      { desk: "sales" },
    ).catch((error) => console.error("[founder-meeting-reminders] failure alert threw", error));
  }
}

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  let reconciliation: FounderMeetingReconciliationResult;
  try {
    reconciliation = await reconcileFounderMeetingSagas({ now: new Date(now), limit: BATCH_LIMIT }, bookingMeetRoomDeps());
  } catch (error) {
    const detail = error instanceof Error ? error.message : "meeting_saga_reconciliation_failed";
    console.error("[founder-meeting-reminders] saga reconciliation degraded", detail);
    reconciliation = {
      considered: 0,
      activated: 0,
      cancelled: 0,
      compensated: 0,
      released: 0,
      failed: 1,
      errors: ["meeting_saga_reconciliation_failed"],
    };
  }
  let backfill: FounderMeetingNotificationBackfillResult;
  try {
    backfill = await backfillFounderMeetingNotifications({ now: new Date(now), limit: BATCH_LIMIT });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "meeting_notification_backfill_failed";
    console.error("[founder-meeting-reminders] notification backfill degraded", detail);
    backfill = {
      considered: 0,
      repaired: 0,
      failed: 1,
      errors: ["meeting_notification_backfill_failed"],
    };
  }

  const expiredLeases = await db.from("call_appointments")
    .update({ notification_lease_token: null, notification_lease_expires_at: null, updated_at: now })
    .lt("notification_lease_expires_at", now)
    .select("id");
  if (expiredLeases.error) {
    await setHealth({ status: "degraded", processed: 0, failed: 1, error: expiredLeases.error.message });
    return NextResponse.json({ ok: false, error: "appointment_lease_recovery_failed" }, { status: 500 });
  }

  const deliveryUnknown = await db.from("website_sales_meeting_notifications")
    .update({
      status: "failed",
      claimed_at: null,
      last_error: "delivery_state_unknown_after_worker_interruption",
      updated_at: now,
    })
    .eq("status", "sending")
    .lt("claimed_at", stale)
    .select("id");
  if (deliveryUnknown.error) {
    await setHealth({ status: "degraded", processed: 0, failed: 1, error: deliveryUnknown.error.message });
    return NextResponse.json({ ok: false, error: "stale_claim_recovery_failed" }, { status: 500 });
  }

  const tracking = await db.from("website_sales_meeting_notifications")
    .select("id,tenant_id,appointment_id,lead_id,kind,reminder_minutes_before,channel,due_at,recipient,sender_user_id,subject,body,attempts,appointment_revision,attempt_token,provider,provider_receipt,sent_at,tracking_attempts")
    .eq("status", "sent")
    .eq("tracking_status", "pending")
    .order("sent_at", { ascending: true })
    .limit(BATCH_LIMIT);
  let trackingFailures = 0;
  let tracked = 0;
  if (tracking.error) {
    trackingFailures += 1;
    console.error("[founder-meeting-reminders] tracking queue lookup failed", tracking.error.message);
  } else {
    for (const raw of (tracking.data || []) as NotificationRow[]) {
      try {
        await persistReminderTracking(db, raw);
        tracked += 1;
      } catch (error) {
        trackingFailures += 1;
        const detail = error instanceof Error ? error.message : "reminder_tracking_failed";
        console.error("[founder-meeting-reminders] tracking retry failed", raw.id, detail);
        await markTrackingError(db, raw, detail).catch((writeError) => {
          console.error("[founder-meeting-reminders] tracking retry state failed", raw.id, writeError);
        });
      }
    }
  }

  // Calls in their slot or just past it: the founder's "lead is waiting" note,
  // and missed meetings closed out with the lead's rebook link queued. Before
  // the due query, so what it queues goes out in this same run.
  let watch: WatchResult = { guestWaiting: 0, noShows: 0, held: 0, errors: [] };
  // Only where Oasis Meet rooms exist (the Turso data plane, as
  // bookingMeetRoomDeps decides): on the Supabase fallback there is no room
  // column and no join data, so there is nothing to watch (Codex review).
  if (bookingMeetRoomDeps().meetRooms) {
    try {
      watch = await watchFounderMeetings({ db, now: () => Date.now(), origin: SITE_ORIGIN });
    } catch (error) {
      watch = { guestWaiting: 0, noShows: 0, held: 0, errors: [error instanceof Error ? error.message : "meeting_watch_failed"] };
    }
  }
  if (watch.errors.length) console.error("[founder-meeting-reminders] meeting watch degraded", watch.errors);
  // The due cutoff is taken AFTER the watcher, so what it just queued (a "lead
  // is waiting" note, a rebook link) goes out in this same run (Codex review).
  const dueBy = new Date().toISOString();

  // Founder meetings are OASIS-only today; the retired-tenant exclusion keeps
  // it that way if a retired tenant ever carries a queued reminder.
  const due = await db.from("website_sales_meeting_notifications")
    .select("id,tenant_id")
    .eq("status", "pending")
    .lte("due_at", dueBy)
    .not("tenant_id", "in", RETIRED_TENANT_ID_LIST)
    .order("due_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (due.error) {
    await setHealth({ status: "degraded", processed: 0, failed: 1, error: due.error.message });
    return NextResponse.json({ ok: false, error: "notification_query_failed" }, { status: 500 });
  }

  let processed = 0;
  let sent = 0;
  let skipped = 0;
  let failures = reconciliation.failed + backfill.failed + trackingFailures + (deliveryUnknown.data?.length || 0) + watch.errors.length;
  const senderPass: SenderPass = { standings: new Map(), withheld: [] };
  for (const candidate of (due.data || []) as Array<{ id: string; tenant_id: string }>) {
    const attemptToken = randomUUID();
    const claimed = await db.from("website_sales_meeting_notifications")
      .update({ status: "sending", claimed_at: now, attempt_token: attemptToken, updated_at: now })
      .eq("tenant_id", candidate.tenant_id)
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select("id,tenant_id,appointment_id,lead_id,kind,reminder_minutes_before,channel,due_at,recipient,sender_user_id,subject,body,attempts,appointment_revision,attempt_token")
      .maybeSingle();
    if (claimed.error) {
      failures++;
      console.error("[founder-meeting-reminders] claim failed", candidate.id, claimed.error.message);
      continue;
    }
    if (!claimed.data) continue;
    processed++;
    try {
      const outcome = await processRow(db, claimed.data as NotificationRow, senderPass);
      if (outcome === "sent") sent++;
      else if (outcome === "skipped") skipped++;
      else if (outcome === "failed") failures++;
    } catch (error) {
      failures++;
      const detail = error instanceof Error ? error.message : "unhandled_notification_error";
      console.error("[founder-meeting-reminders] row failed", candidate.id, detail);
      if (error instanceof DeliveryStateUnknownError) {
        console.error("[founder-meeting-reminders] delivery state left terminal-unknown until stale recovery", candidate.id);
      } else {
        await retryOrFail(db, claimed.data as NotificationRow, detail).catch((writeError) => {
          console.error("[founder-meeting-reminders] retry write failed", candidate.id, writeError);
        });
      }
    }
  }
  if (senderPass.withheld.length) await alertWithheldReminders(senderPass.withheld);
  await alertFailedReminders(db, now);

  await setHealth({
    status: failures ? "degraded" : "healthy",
    processed,
    failed: failures,
    error: failures ? `${failures} notification(s) failed this run` : undefined,
  });
  return NextResponse.json({
    ok: failures === 0,
    delivery_unknown: deliveryUnknown.data?.length || 0,
    expired_leases: expiredLeases.data?.length || 0,
    reconciliation,
    backfill,
    meeting_watch: watch,
    tracking_reconciled: tracked,
    tracking_failed: trackingFailures,
    claimed: processed,
    sent,
    skipped,
    failed: failures,
  }, { status: failures ? 503 : 200 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
