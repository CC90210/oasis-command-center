-- Preserve the client-visible offer name across booking retries, reminder
-- repairs, reschedules, and saga reconciliation. Existing founder meetings
-- retain their legacy label; public funnel bookings provide an explicit one.
ALTER TABLE "call_appointments" ADD COLUMN "offer_label" TEXT;

UPDATE "call_appointments"
SET "offer_label" = CASE
  WHEN "duration_minutes" = 15 THEN 'website audit'
  ELSE 'discovery call'
END
WHERE "meeting_kind" = 'founder_audit'
  AND "offer_label" IS NULL;
