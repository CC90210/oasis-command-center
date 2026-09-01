import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { sendGmailAsOperator } from "@/lib/integrations/gmail-oauth-send";
import { isDryRun } from "@/lib/integrations/send-mode";
import { sendSmsDirectTwilio, tenantHasDirectTwilio } from "@/lib/sms-direct-twilio";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { checkTcpaWindow, dispatchByTcpaWindow } from "@/lib/tcpa-window";
import {
  backfillFounderMeetingNotifications,
  reconcileFounderMeetingSagas,
  type FounderMeetingNotificationBackfillResult,
  type FounderMeetingReconciliationResult,
} from "@/lib/website-sales-founder-meeting";
import {
  buildFounderMeetingMessages,
  clampSmsBody,
  meetingNotificationDecision,
  minutesUntilMeeting,
  reminderTierStillValid,
  withSmsFooter,
  type FounderReminderTier,
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
  kind: "confirmation" | "reminder_60" | "reminder_30" | "ten_minute";
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
  client_name_snapshot: string | null;
  company_snapshot: string | null;
  client_agenda: string | null;
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

async function retryOrFail(db: Db, row: NotificationRow, reason: string) {
  const nextAttempts = row.attempts + 1;
  await mark(db, row, nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending", {
    error: reason,
    incrementAttempt: true,
  });
}

async function acquireAppointmentLease(
  db: Db,
  row: NotificationRow,
  appointment: AppointmentState,
  now: string,
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
    .eq("status", "scheduled")
    .eq("workflow_status", "active")
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
  await recordTouch(db, row, row.provider, row.provider_receipt, row.sent_at);
  await markTrackingComplete(db, row);
}

async function processRow(db: Db, row: NotificationRow): Promise<"sent" | "skipped" | "failed" | "held"> {
  const appointmentResult = await db.from("call_appointments")
    .select("id,scheduled_for,status,calendar_status,workflow_status,revision,sms_consent,client_phone_snapshot,client_name_snapshot,company_snapshot,client_agenda,timezone,google_meet_link,organizer_email_snapshot,pending_started_at,updated_at,notification_lease_token,notification_lease_expires_at")
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

  const leaseToken = await acquireAppointmentLease(db, row, appointment, decisionAt);
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
      if (![60, 30, 10].includes(tier)) {
        await mark(db, row, "skipped", { error: "reminder_tier_invalid" });
        return "skipped";
      }
      if (!reminderTierStillValid(tier as FounderReminderTier, actualMinutes)) {
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
        reminderMinutesBefore: actualMinutes,
      });
      deliveryRow = {
        ...row,
        subject: messages.reminder.subject,
        body: row.channel === "email" ? messages.reminder.body : messages.reminder.sms,
      };
    }

    let provider = "";
    let receipt = "";
    if (row.channel === "email") {
      if (!appointment.organizer_email_snapshot) {
        await mark(db, row, "failed", { error: "approved_sender_missing", incrementAttempt: true });
        return "failed";
      }
      const sent = await sendGmailAsOperator({
        tenantId: row.tenant_id,
        userId: row.sender_user_id,
        to: row.recipient,
        subject: deliveryRow.subject || "Your OASIS meeting reminder",
        body: deliveryRow.body,
        expectedFromAddress: appointment.organizer_email_snapshot,
        idempotencyKey: row.attempt_token,
      });
      if (!sent.ok) {
        if (sent.reason === "sender_mismatch" || sent.reason === "delivery_unknown") {
          await mark(db, row, "failed", { error: `${sent.reason}:${sent.error}`, incrementAttempt: true });
        } else {
          await retryOrFail(db, row, `${sent.reason}:${sent.error}`);
        }
        return "failed";
      }
      provider = sent.provider;
      receipt = sent.gmail_message_id;
    } else {
      if (!appointment.sms_consent || appointment.client_phone_snapshot !== row.recipient) {
        await mark(db, row, "skipped", { error: "sms_consent_missing_or_recipient_changed" });
        return "skipped";
      }
      const quietHours = checkTcpaWindow(row.recipient, new Date());
      const windowDisposition = await dispatchByTcpaWindow(quietHours, {
        skip: async (error) => {
          await mark(db, row, "skipped", { error });
          return "skipped" as const;
        },
        send: () => "send" as const,
      });
      if (windowDisposition === "skipped") return "skipped";
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
      deliveryRow = {
        ...deliveryRow,
        body: clampSmsBody(withSmsFooter(deliveryRow.body, {
          firstInConversation: (priorSms.data || []).length === 0,
        })),
      };
      if (!(await tenantHasDirectTwilio(row.tenant_id))) {
        await mark(db, row, "skipped", { error: "oasis_sms_not_configured" });
        return "skipped";
      }
      if (isDryRun("twilio")) {
        await mark(db, row, "skipped", { error: "twilio_live_send_disabled" });
        return "skipped";
      }
      const sent = await sendSmsDirectTwilio({
        tenantId: row.tenant_id,
        to: row.recipient,
        body: deliveryRow.body,
      });
      if (!sent.ok) {
        await retryOrFail(db, row, sent.error);
        return "failed";
      }
      provider = sent.provider;
      receipt = sent.message_sid;
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
    if (!retainLeaseUntilRecovery) {
      try {
        await releaseAppointmentLease(db, row, leaseToken);
      } catch (error) {
        console.error("[founder-meeting-reminders] appointment lease release failed", row.id, error);
      }
    }
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
    reconciliation = await reconcileFounderMeetingSagas({ now: new Date(now), limit: BATCH_LIMIT });
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

  const due = await db.from("website_sales_meeting_notifications")
    .select("id,tenant_id")
    .eq("status", "pending")
    .lte("due_at", now)
    .order("due_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (due.error) {
    await setHealth({ status: "degraded", processed: 0, failed: 1, error: due.error.message });
    return NextResponse.json({ ok: false, error: "notification_query_failed" }, { status: 500 });
  }

  let processed = 0;
  let sent = 0;
  let skipped = 0;
  let failures = reconciliation.failed + backfill.failed + trackingFailures + (deliveryUnknown.data?.length || 0);
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
      const outcome = await processRow(db, claimed.data as NotificationRow);
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
