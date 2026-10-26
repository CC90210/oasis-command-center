-- 242 - Oasis Meet: the computers that claimed a recording's transcription
-- before bravo__240, recorded as its copies (2026-10-26). Apply after 240.
--
-- After applying, this must return no rows (and again after the deploy):
--
--   SELECT DISTINCT t.room_id FROM meet_transcripts t JOIN tool_jobs o ON o.tenant_id = t.tenant_id AND o.dedupe_key = 'meet_transcribe:' || t.room_id WHERE o.attempts > 0 AND o.claimed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM meet_local_copies c WHERE c.tenant_id = t.tenant_id AND c.room_id = t.room_id AND c.runner_key = o.claimed_by);
--
-- A room it returns has a computer that claimed its transcription and is not
-- on record, so "Delete meeting" would not reach that computer. A row that
-- appears only after the deploy is a claim the older code made between this
-- file and the deploy: run the INSERT below again (it adds only what is
-- missing; a Delete of that room also records it, lib/meet/recording.ts).
--
-- EVERY JOB, NOT THE NEWEST. A room's transcription can be claimed by one
-- computer, fail, and be tried again (a new job) by another, or not be taken
-- again before the meeting is deleted. bravo__240's first backfill read only
-- each room's newest job, so the PC that failed the first attempt had no copy
-- on record: Delete told only the Mac, or nobody, and the room was stamped
-- deleted while the PC kept the audio (independent review, 2026-10-26). So:
-- one row per computer that claimed ANY of the room's transcription jobs
-- (claimed_by, attempts > 0); first_claimed_at its earliest claim; its folder
-- when one of its jobs finished (the transcript's folder is the finishing
-- computer's own); and deleted where the room was already stamped.
-- lib/meet/recording.ts LOCAL_COPIES_BACKFILL_SQL is this statement word for
-- word (tests/meet-copies-backfill.test.ts holds them equal), and every Delete
-- runs it for its one room.
--
-- KNOWN LIMIT: a job claimed by one computer and, after its lease lapsed, by
-- another keeps only the second (tool_jobs.claimed_by is overwritten), so the
-- first cannot be recovered from any table. Since bravo__240 each claim is
-- recorded as it is made.
--
-- INSERT OR IGNORE: safe to run again; a copy already on record is never
-- changed. CONVENTIONS as bravo__240.

INSERT OR IGNORE INTO meet_local_copies (tenant_id, room_id, runner_key, first_claimed_at, local_folder, deleted_at, device_label)
SELECT j.tenant_id, substr(j.dedupe_key, length('meet_transcribe:') + 1), j.claimed_by, MIN(COALESCE(j.claimed_at, j.created_at)),
       MAX(CASE WHEN j.status = 'done' THEN t.local_folder END), t.local_deleted_at, NULL
  FROM tool_jobs j
  LEFT JOIN meet_transcripts t ON t.tenant_id = j.tenant_id AND t.room_id = substr(j.dedupe_key, length('meet_transcribe:') + 1)
 WHERE j.tool_key = 'meet_transcribe' AND j.dedupe_key LIKE 'meet_transcribe:%' AND j.claimed_by IS NOT NULL AND j.attempts > 0
 GROUP BY j.tenant_id, j.dedupe_key, j.claimed_by;
