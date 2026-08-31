-- 169 - widen the founder-meeting outbox from one T-10 reminder to
-- revision-safe T-60/T-30/T-10 tiers.
--
-- SQLite cannot alter the existing kind CHECK in place, and the production
-- migration runner intentionally refuses DROP TABLE. Rename the verified v167
-- table aside, copy every row, and leave the retired table as the rollback
-- artifact until production verification is complete.

DROP INDEX "website_sales_meeting_notifications_due_idx";
DROP INDEX "website_sales_meeting_notifications_appointment_idx";
DROP INDEX "website_sales_meeting_notifications_tracking_idx";

ALTER TABLE "website_sales_meeting_notifications"
  RENAME TO "website_sales_meeting_notifications_v167";

CREATE TABLE "website_sales_meeting_notifications" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "appointment_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL
    CHECK ("kind" IN ('confirmation','reminder_60','reminder_30','ten_minute')),
  "reminder_minutes_before" INTEGER,
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

INSERT INTO "website_sales_meeting_notifications" (
  "id",
  "tenant_id",
  "appointment_id",
  "lead_id",
  "kind",
  "reminder_minutes_before",
  "channel",
  "due_at",
  "recipient",
  "sender_user_id",
  "subject",
  "body",
  "status",
  "attempts",
  "appointment_revision",
  "dedupe_key",
  "provider",
  "provider_receipt",
  "last_error",
  "claimed_at",
  "attempt_token",
  "sent_at",
  "tracking_status",
  "tracking_attempts",
  "tracking_last_error",
  "tracked_at",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "tenant_id",
  "appointment_id",
  "lead_id",
  "kind",
  CASE WHEN "kind" = 'ten_minute' THEN 10 END,
  "channel",
  "due_at",
  "recipient",
  "sender_user_id",
  "subject",
  "body",
  "status",
  "attempts",
  "appointment_revision",
  "dedupe_key",
  "provider",
  "provider_receipt",
  "last_error",
  "claimed_at",
  "attempt_token",
  "sent_at",
  "tracking_status",
  "tracking_attempts",
  "tracking_last_error",
  "tracked_at",
  "created_at",
  "updated_at"
FROM "website_sales_meeting_notifications_v167";

CREATE INDEX "website_sales_meeting_notifications_due_idx"
  ON "website_sales_meeting_notifications" ("status", "due_at");
CREATE INDEX "website_sales_meeting_notifications_appointment_idx"
  ON "website_sales_meeting_notifications"
  ("tenant_id", "appointment_id", "appointment_revision");
CREATE INDEX "website_sales_meeting_notifications_tracking_idx"
  ON "website_sales_meeting_notifications" ("tracking_status", "sent_at")
  WHERE "status" = 'sent' AND "tracking_status" = 'pending';

CREATE INDEX "call_appointments_founder_backfill_idx"
  ON "call_appointments" ("meeting_kind", "workflow_status", "status", "scheduled_for");
