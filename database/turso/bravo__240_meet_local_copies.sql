-- 240 - Oasis Meet: every computer's copy of a recording is tracked, and
-- "Delete meeting" reaches each one (2026-10-25).
--
-- Until now one "delete local copy" job (meet_delete_local) went to whichever
-- runner claimed it first. With two computers transcribing (the PC, and now
-- CC's Mac), the Mac could take the job, find nothing, report the copy
-- deleted, and leave the audio on the PC. Now:
--
-- meet_local_copies  one row per (recording, runner) that ever claimed its
--                    transcription: the runner may hold the audio. deleted_at
--                    is stamped when THAT runner reports its copy gone.
-- tool_jobs.target_runner  a job only this runner may claim (claimNextJob
--                    filters on it). NULL, as for every existing job: any
--                    runner of the right tool, as before.
--
-- meet_transcripts.local_deleted_at is stamped only when every tracked copy
-- of the room is gone (lib/meet/recording.ts). Rooms transcribed before this
-- migration have no rows here and keep the old single, untargeted delete.
--
-- CONVENTIONS as bravo__206 / bravo__233: text ids and ISO-8601 UTC times
-- written by the app, tenant_id first in every index. Additive only.

ALTER TABLE tool_jobs ADD COLUMN target_runner TEXT;

CREATE INDEX IF NOT EXISTS tool_jobs_target_runner_idx
  ON tool_jobs (tenant_id, target_runner, status) WHERE target_runner IS NOT NULL;

CREATE TABLE IF NOT EXISTS meet_local_copies (
  tenant_id        TEXT NOT NULL,
  room_id          TEXT NOT NULL,
  runner_key       TEXT NOT NULL,
  first_claimed_at TEXT NOT NULL,
  deleted_at       TEXT,
  device_label     TEXT,
  PRIMARY KEY (tenant_id, room_id, runner_key)
);

CREATE INDEX IF NOT EXISTS meet_local_copies_open_idx
  ON meet_local_copies (tenant_id, room_id) WHERE deleted_at IS NULL;
