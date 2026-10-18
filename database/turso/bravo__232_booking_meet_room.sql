-- bravo__232_booking_meet_room.sql - a booked founder meeting holds the Oasis Meet room it was given.
--
-- CC (2026-10-18): every booking (/book, the offer forms' inline calendar, a rep's Book the Meet) gets its own
-- Oasis Meet link instead of a Google Meet. The room is made once per appointment: a replayed booking finds it
-- here and reuses it, never makes a second; a reschedule moves it and a cancel deletes it by this id, never by
-- lead_id (one lead can book twice). NULL: no room (a booking made before this, or one that fell back to Google
-- Meet because Oasis Meet's media was not set up). The link itself stays in google_meet_link, which every reader
-- of the receipt already uses.
--
-- Additive only. Runs once: scripts/apply_turso_migration.py records it in its ledger and skips it after that.

ALTER TABLE "call_appointments" ADD COLUMN "meet_room_id" TEXT;

CREATE INDEX IF NOT EXISTS "idx_call_appointments_meet_room" ON "call_appointments" ("tenant_id", "meet_room_id")
  WHERE "meet_room_id" IS NOT NULL;
