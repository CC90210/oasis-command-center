-- bravo__250_founder_meeting_reminder_ladder.sql (2026-10-28)
--
-- The founder-meeting outbox learns the reminder ladder CC asked for (texts at
-- 30, 15 and 5 minutes, email and text the day before and at 15 minutes), the
-- founder's own heads-up, and the missed-meeting follow-ups. New kinds:
--
--   reminder_1440        the day before (email; text inside the lead's daytime)
--   reminder_15          15 minutes before (email + text)
--   reminder_5           5 minutes before (text)
--   host_15              the founder's 15-minute heads-up (who, company, link)
--   host_guest_waiting   the lead is in the room and no host is (once per meeting)
--   no_show_rebook       the lead's rebook link after a missed meeting
--   no_show_followup     the +24 h / +72 h nudges until they rebook
--
-- reminder_60, reminder_30 and ten_minute stay: rows already queued keep their
-- kind, and ten_minute is still read by the dispatcher.
--
-- Same shape as 169: SQLite cannot alter a CHECK in place and the migration
-- runner refuses to remove a table, so the v169 table is renamed aside, every
-- row is copied, and the renamed table stays as the rollback artifact. The
-- indexes go first because SQLite keeps index names global.

DROP INDEX "website_sales_meeting_notifications_due_idx";
DROP INDEX "website_sales_meeting_notifications_appointment_idx";
DROP INDEX "website_sales_meeting_notifications_tracking_idx";

ALTER TABLE "website_sales_meeting_notifications"
  RENAME TO "website_sales_meeting_notifications_v169";

CREATE TABLE "website_sales_meeting_notifications" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "appointment_id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL
    CHECK ("kind" IN (
      'confirmation',
      'reminder_1440','reminder_60','reminder_30','reminder_15','reminder_5','ten_minute',
      'host_15','host_guest_waiting',
      'no_show_rebook','no_show_followup'
    )),
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
FROM "website_sales_meeting_notifications_v169";

CREATE INDEX "website_sales_meeting_notifications_due_idx"
  ON "website_sales_meeting_notifications" ("status", "due_at");
CREATE INDEX "website_sales_meeting_notifications_appointment_idx"
  ON "website_sales_meeting_notifications"
  ("tenant_id", "appointment_id", "appointment_revision");
CREATE INDEX "website_sales_meeting_notifications_tracking_idx"
  ON "website_sales_meeting_notifications" ("tracking_status", "sent_at")
  WHERE "status" = 'sent' AND "tracking_status" = 'pending';
