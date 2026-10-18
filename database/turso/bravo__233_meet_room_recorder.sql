-- bravo__233_meet_room_recorder.sql - Oasis Meet: which browser records a room (2026-10-18).
--
-- CC: whichever host is in the call records it (Adon from his own account, not only the room's creator), and
-- exactly one browser records at a time. recorder_participant_id names the meet_participants row (one browser's
-- join) that records the room now. NULL: no browser records it yet.
--
-- A host's browser takes it on its join or poll when nobody holds it, or its holder has left, been removed or gone
-- silent (lib/meet/participants.ts claimRecorder): one conditional UPDATE, so two hosts never both take it. There is
-- no timestamp here: the holder's own last_seen_at, which its poll already keeps, says whether it is still there.
--
-- Additive only. Runs once: scripts/apply_turso_migration.py records it in its ledger and skips it after that.

ALTER TABLE "meet_rooms" ADD COLUMN "recorder_participant_id" TEXT;
