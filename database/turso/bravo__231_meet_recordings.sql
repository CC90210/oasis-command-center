-- 231 - Oasis Meet: the recording relay and the transcripts (2026-10-17).
--
-- CC: no vendor bill for recording, and the recordings live "on the local
-- computer". The host's browser records each speaker's voice
-- (lib/meet/recorder.ts) and uploads it in 10-second chunks. The chunks wait in
-- R2 (meet-relay/<tenant>/<room>/<participant>/<segment>/<seq>) only until
-- OASIS's PC has taken them, kept the audio and transcribed it (BEA
-- scripts/meet/runner.py); then they are deleted. The transcript is kept.
--
-- meet_recording_chunks: one row per uploaded chunk. (participant, segment,
-- seq) is unique per room, so a retried upload is the same chunk.
-- segment_started_ms is the recording browser's clock at the segment's first
-- byte (ms since the epoch). uploaded_by is the host whose browser sent it: one
-- browser records a room at a time.
--
-- meet_transcripts: one row per room once its recording is handed to the PC.
--   queued        a meet_transcribe job waits for the PC
--   transcribing  the PC took it; segments_json is exactly what it was given
--   ready         the transcript is here; the audio is on device_label, in
--                 local_folder
--   expired       the PC never took it within 30 days of the meeting's end
--                 (relay_expires_at): the audio was deleted unheard
--   deleted       the host deleted the recording: the text is gone and the PC
--                 is told to delete its copy (local_deleted_at when it has)
-- relay_cleared_at is when the last relay chunk of a ready, expired or deleted
-- recording was deleted.
--
-- Additive only: two new tables and their indexes, nothing existing touched.

CREATE TABLE IF NOT EXISTS meet_recording_chunks (
  id                 text not null primary key,
  tenant_id          text not null,
  room_id            text not null,
  participant_id     text not null,
  display_name       text not null,
  segment_id         text not null,
  seq                integer not null check (seq >= 0),
  segment_started_ms integer not null,
  mime_type          text not null,
  bytes              integer not null check (bytes > 0),
  storage_path       text not null,
  uploaded_by        text not null,
  created_at         text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meet_chunks_seq ON meet_recording_chunks (tenant_id, room_id, participant_id, segment_id, seq);
CREATE INDEX IF NOT EXISTS idx_meet_chunks_room_created ON meet_recording_chunks (tenant_id, room_id, created_at);

CREATE TABLE IF NOT EXISTS meet_transcripts (
  id                 text not null primary key,
  tenant_id          text not null,
  room_id            text not null,
  status             text not null default 'queued' check (status in ('queued', 'transcribing', 'ready', 'expired', 'deleted')),
  job_id             text,
  segments_json      text not null default '[]',
  chunk_count        integer not null default 0,
  audio_bytes        integer not null default 0,
  missing_chunks     integer not null default 0,
  text               text,
  lines_json         text,
  model              text,
  transcribe_seconds real,
  device_label       text,
  local_folder       text,
  relay_expires_at   text not null,
  created_at         text not null,
  updated_at         text not null,
  ready_at           text,
  deleted_at         text,
  local_deleted_at   text,
  relay_cleared_at   text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meet_transcripts_room ON meet_transcripts (tenant_id, room_id);
CREATE INDEX IF NOT EXISTS idx_meet_transcripts_status_expiry ON meet_transcripts (status, relay_expires_at);
-- The relay cleanup reads only recordings that are done with but may still
-- have chunks (relay_cleared_at stamps the moment the last one went), so its
-- cost does not grow with every meeting ever held.
CREATE INDEX IF NOT EXISTS idx_meet_transcripts_uncleared ON meet_transcripts (tenant_id, status) WHERE relay_cleared_at IS NULL;
