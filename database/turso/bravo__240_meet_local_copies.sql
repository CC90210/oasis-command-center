-- 240 - Oasis Meet: every computer's copy of a recording is tracked, and
-- "Delete meeting" reaches each one (2026-10-25; revised 2026-10-26 after the
-- independent reviews, before it was applied anywhere).
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
-- idx_tool_jobs_tenant_dedupe  a room's jobs in ANY status: the latest delete
--                    of each copy (the panel), whether a copy has a delete at
--                    all (the sweep), every transcription a room had (the
--                    backfill). uq_tool_jobs_tenant_inflight (bravo__206) holds
--                    only the jobs in flight, so it cannot answer these.
--
-- The computers that claimed a transcription before this migration are recorded
-- by bravo__242 (the backfill, in its own file: see ORDER), and
-- lib/meet/recording.ts records one the older code claimed after it ran.
-- meet_transcripts.local_deleted_at is stamped only when every tracked copy
-- of the room is gone, and only by a delete addressed to one computer.
--
-- ORDER. Every statement here is IF NOT EXISTS except the ALTER, which cannot
-- run twice, so it is the last: a run that stops at its first failure never
-- leaves the column (which lib/tools/store.ts toolTablesInstalled takes to mean
-- this migration is in) without the table and indexes before it. The backfill
-- reads data and is the statement most likely to fail; after the ALTER, its
-- failure made every rerun stop at "duplicate column" (the migration tool
-- writes the ledger only when every statement succeeded), so it is bravo__242,
-- which is safe to run again.
--
-- CONVENTIONS as bravo__206 / bravo__233: text ids and ISO-8601 UTC times
-- written by the app, tenant_id first in every index. Additive only.

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

CREATE INDEX IF NOT EXISTS idx_tool_jobs_tenant_dedupe ON tool_jobs (tenant_id, dedupe_key, created_at);

ALTER TABLE tool_jobs ADD COLUMN target_runner TEXT;
