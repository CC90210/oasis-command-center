-- 240 - Oasis Meet: every computer's copy of a recording is tracked, and
-- "Delete meeting" reaches each one (2026-10-25; revised 2026-10-26 after the
-- independent review, before it was applied anywhere).
--
-- Until now one "delete local copy" job (meet_delete_local) went to whichever
-- runner claimed it first. With two computers transcribing (the PC, and now
-- CC's Mac), the Mac could take the job, find nothing, report the copy
-- deleted, and leave the audio on the PC. Now:
--
-- meet_local_copies  one row per (recording, runner) that ever claimed its
--                    transcription: the runner may hold the audio.
--                    local_folder is the folder THAT runner reported for its
--                    transcript, so each computer is sent only its own (a PC
--                    path sent to the Mac is refused as unsafe). deleted_at is
--                    stamped when that runner reports its copy gone.
-- tool_jobs.target_runner  a job only this runner may claim (claimNextJob
--                    filters on it). NULL, as for every existing job: any
--                    runner of the right tool, as before. No index: the claim's
--                    "IS NULL OR = ?" could not use one.
--
-- The backfill below records every computer that claimed a transcription
-- before this migration (tool_jobs keeps claimed_by), with the folder when that
-- computer finished it and the delete already done where it was, so an older
-- meeting's Delete reaches the right computer too, never "whichever polls first".
-- lib/meet/recording.ts does the same for a claim made by older code between
-- this migration and the deploy.
--
-- meet_transcripts.local_deleted_at is stamped only when every tracked copy
-- of the room is gone (lib/meet/recording.ts).
--
-- CONVENTIONS as bravo__206 / bravo__233: text ids and ISO-8601 UTC times
-- written by the app, tenant_id first in every index. Additive only.

ALTER TABLE tool_jobs ADD COLUMN target_runner TEXT;

CREATE TABLE IF NOT EXISTS meet_local_copies (
  tenant_id        TEXT NOT NULL,
  room_id          TEXT NOT NULL,
  runner_key       TEXT NOT NULL,
  first_claimed_at TEXT NOT NULL,
  local_folder     TEXT,
  deleted_at       TEXT,
  device_label     TEXT,
  PRIMARY KEY (tenant_id, room_id, runner_key)
);

CREATE INDEX IF NOT EXISTS meet_local_copies_open_idx
  ON meet_local_copies (tenant_id, room_id) WHERE deleted_at IS NULL;

INSERT OR IGNORE INTO meet_local_copies (tenant_id, room_id, runner_key, first_claimed_at, local_folder, deleted_at, device_label)
SELECT t.tenant_id, t.room_id, j.claimed_by, COALESCE(j.claimed_at, j.created_at),
       CASE WHEN j.status = 'done' THEN t.local_folder END, t.local_deleted_at, NULL
  FROM meet_transcripts t
  JOIN tool_jobs j ON j.tenant_id = t.tenant_id AND j.id = t.job_id
 WHERE j.tool_key = 'meet_transcribe' AND j.claimed_by IS NOT NULL AND j.attempts > 0;
