-- 167 - verified founder-audit appointments and a retry-safe reminder outbox.
-- Production is Turso/libSQL. Google receipts live on the canonical
-- call_appointments row; client notifications are revisioned so a reschedule
-- can never send the prior time.

ALTER TABLE "call_appointments" ADD COLUMN "meeting_kind" TEXT NOT NULL DEFAULT 'sales_call';
ALTER TABLE "call_appointments" ADD COLUMN "duration_minutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "call_appointments" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Toronto';
ALTER TABLE "call_appointments" ADD COLUMN "client_name_snapshot" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "company_snapshot" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "client_email_snapshot" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "client_phone_snapshot" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "website_snapshot" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "client_agenda" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "handoff_note" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "google_calendar_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "google_event_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "google_event_html_link" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "google_meet_link" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "google_ical_uid" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "calendar_status" TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE "call_appointments" ADD COLUMN "calendar_error" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "booking_request_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "last_reschedule_request_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "last_cancel_request_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "last_rescheduled_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "cancelled_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "call_appointments" ADD COLUMN "workflow_status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "call_appointments" ADD COLUMN "sms_consent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "call_appointments" ADD COLUMN "sms_consent_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "organizer_email_snapshot" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "contact_confirmed_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "time_confirmed_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "handoff_confirmed_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "confirmed_by" TEXT;
-- A lifecycle operation is reserved on the appointment before any provider
-- mutation. The token + started_at pair is the compare-and-swap lease: only
-- the holder may publish the Google receipt, and an abandoned holder can be
-- taken over by the same idempotency request after the bounded lease expires.
ALTER TABLE "call_appointments" ADD COLUMN "pending_request_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "pending_operation" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "pending_meeting_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "pending_started_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "pending_lease_token" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "previous_scheduled_for" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "previous_status" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "previous_workflow_status" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "pending_provider_applied_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "pending_compensation_applied_at" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "last_compensated_request_id" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "last_reconciled_at" TEXT;
-- Reminder delivery and lifecycle mutation share this appointment lease. A
-- reschedule/cancel cannot race a T-10 provider send for the old revision.
ALTER TABLE "call_appointments" ADD COLUMN "notification_lease_token" TEXT;
ALTER TABLE "call_appointments" ADD COLUMN "notification_lease_expires_at" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "call_appointments_booking_request_uidx"
  ON "call_appointments" ("tenant_id", "booking_request_id")
  WHERE "booking_request_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "call_appointments_google_event_uidx"
  ON "call_appointments" ("tenant_id", "google_calendar_id", "google_event_id")
  WHERE "google_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "call_appointments_reschedule_request_uidx"
  ON "call_appointments" ("tenant_id", "last_reschedule_request_id")
  WHERE "last_reschedule_request_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "call_appointments_cancel_request_uidx"
  ON "call_appointments" ("tenant_id", "last_cancel_request_id")
  WHERE "last_cancel_request_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "call_appointments_pending_request_uidx"
  ON "call_appointments" ("tenant_id", "pending_request_id")
  WHERE "pending_request_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "call_appointments_pending_saga_idx"
  ON "call_appointments" ("workflow_status", "pending_started_at");
CREATE INDEX IF NOT EXISTS "call_appointments_notification_lease_idx"
  ON "call_appointments" ("notification_lease_expires_at")
  WHERE "notification_lease_token" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "website_sales_meeting_notifications" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "appointment_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('confirmation','ten_minute')),
  "channel" TEXT NOT NULL CHECK ("channel" IN ('email','sms')),
  "due_at" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "sender_user_id" TEXT NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending','sending','sent','skipped','failed','cancelled')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "appointment_revision" INTEGER NOT NULL DEFAULT 1,
  "dedupe_key" TEXT NOT NULL,
  "provider" TEXT,
  "provider_receipt" TEXT,
  "last_error" TEXT,
  "claimed_at" TEXT,
  "attempt_token" TEXT,
  "sent_at" TEXT,
  "tracking_status" TEXT NOT NULL DEFAULT 'not_required'
    CHECK ("tracking_status" IN ('not_required','pending','tracked')),
  "tracking_attempts" INTEGER NOT NULL DEFAULT 0,
  "tracking_last_error" TEXT,
  "tracked_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("appointment_id") REFERENCES "call_appointments" ("id") ON DELETE CASCADE,
  UNIQUE ("tenant_id", "dedupe_key")
);

CREATE INDEX IF NOT EXISTS "website_sales_meeting_notifications_due_idx"
  ON "website_sales_meeting_notifications" ("status", "due_at");
CREATE INDEX IF NOT EXISTS "website_sales_meeting_notifications_appointment_idx"
  ON "website_sales_meeting_notifications" ("tenant_id", "appointment_id", "appointment_revision");
CREATE INDEX IF NOT EXISTS "website_sales_meeting_notifications_tracking_idx"
  ON "website_sales_meeting_notifications" ("tracking_status", "sent_at")
  WHERE "status" = 'sent' AND "tracking_status" = 'pending';

-- A provider delivery and its canonical touch are separate durable steps. This
-- expression index makes the touch retry idempotent if a worker stops after
-- inserting the interaction but before marking the outbox row tracked.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_interactions_meeting_notification_uidx"
  ON "lead_interactions" ("tenant_id", json_extract("metadata", '$.notification_id'))
  WHERE "agent_source" = 'founder_meeting_reminder'
    AND json_extract("metadata", '$.notification_id') IS NOT NULL;

CREATE TABLE IF NOT EXISTS "website_sales_meeting_worker_health" (
  "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
  "status" TEXT NOT NULL CHECK ("status" IN ('healthy','degraded')),
  "last_run_at" TEXT NOT NULL,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
