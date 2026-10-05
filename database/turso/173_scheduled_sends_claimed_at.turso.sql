-- 173_scheduled_sends_claimed_at.turso.sql
-- Turso parity for the scheduled-send worker lease introduced in migration 173.

ALTER TABLE "scheduled_sends" ADD COLUMN "claimed_at" TEXT;

CREATE INDEX IF NOT EXISTS "idx_scheduled_sends_status_channel_claimed"
  ON "scheduled_sends" ("status", "channel", "claimed_at");

UPDATE "scheduled_sends"
   SET "claimed_at" = datetime('now')
 WHERE "status" = 'sending'
   AND "claimed_at" IS NULL;
