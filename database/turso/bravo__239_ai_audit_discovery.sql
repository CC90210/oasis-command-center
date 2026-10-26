-- 239 - Free AI Audit: discovery call transcripts and live-call notes
-- (2026-10-25, phase 2).
--
-- ai_audit_transcripts  a discovery call's transcript as numbered lines
--                       (lib/ai-audit/transcript.ts): pasted, uploaded
--                       (.txt / .vtt / .srt) or attached from Oasis Meet.
--                       Credentials are removed before the row is written, and
--                       the hash is taken over what is stored. Consent is part
--                       of the row: recording and AI analysis, who attested it
--                       and when ('owner_attested' when CC ticks it for a call
--                       held elsewhere, 'founder_attested' when another
--                       founder does, 'meet_guests' when every Meet guest
--                       agreed on joining). A transcript's lines never change
--                       (trigger); deleting one wipes its lines and keeps its
--                       hash, so a frozen profile that cited it still says
--                       which text it came from.
-- ai_audit_call_notes   CC's notes per framework question (lib/ai-audit/
--                       framework.ts), saved as he types. row_version is the
--                       compare-and-swap counter, so two open tabs cannot
--                       silently overwrite each other.
-- ai_audit_engagements  gains call_started_at (the live-call screen's clock)
--                       and call_ended_at.
--
-- CONVENTIONS as bravo__237: text ids, ISO-8601 UTC times written by the app,
-- tenant_id first in every index, vocabularies checked in lib/ai-audit/*.ts.
-- Additive only.

CREATE TABLE IF NOT EXISTS ai_audit_transcripts (
  id                text not null primary key,
  tenant_id         text not null,
  engagement_id     text not null,
  source            text not null,
  format            text not null,
  filename          text,
  meet_room_id      text,
  lines_json        text not null default '[]',
  line_count        integer not null default 0,
  char_count        integer not null default 0,
  speakers_json     text not null default '[]',
  text_sha256       text not null,
  redactions        integer not null default 0,
  consent_recording integer not null check (consent_recording in (0, 1)),
  consent_ai        integer not null check (consent_ai in (0, 1)),
  consent_basis     text not null,
  consent_by        text,
  consent_at        text not null,
  status            text not null default 'active',
  created_by        text,
  created_at        text not null,
  deleted_at        text,
  deleted_by        text
);

-- The same text twice on one engagement is one transcript (a double-click, a re-upload).
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_transcripts_text_uq
  ON ai_audit_transcripts (tenant_id, engagement_id, text_sha256) WHERE status = 'active';
-- One Meet recording attaches once.
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_transcripts_meet_uq
  ON ai_audit_transcripts (tenant_id, engagement_id, meet_room_id) WHERE meet_room_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS ai_audit_transcripts_engagement_idx
  ON ai_audit_transcripts (tenant_id, engagement_id, created_at);

-- Lines, hash and consent are written once. The only later change is a
-- delete: status 'deleted' with the lines, the file name and the speakers'
-- names wiped, everything else as it was. A status change on its own (lines
-- kept) is refused too.
CREATE TRIGGER IF NOT EXISTS ai_audit_transcripts_frozen
BEFORE UPDATE OF lines_json, text_sha256, consent_recording, consent_ai, consent_basis, consent_by, consent_at, engagement_id, tenant_id, status, filename, speakers_json ON ai_audit_transcripts
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'deleted' AND NEW.lines_json = '[]'
  AND NEW.filename IS NULL AND NEW.speakers_json = '[]'
  AND NEW.text_sha256 = OLD.text_sha256
  AND NEW.consent_recording = OLD.consent_recording AND NEW.consent_ai = OLD.consent_ai
  AND NEW.consent_basis = OLD.consent_basis AND COALESCE(NEW.consent_by, '') = COALESCE(OLD.consent_by, '')
  AND NEW.consent_at = OLD.consent_at
  AND NEW.engagement_id = OLD.engagement_id AND NEW.tenant_id = OLD.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_transcript_frozen');
END;

CREATE TRIGGER IF NOT EXISTS ai_audit_transcripts_no_undelete
BEFORE UPDATE OF status ON ai_audit_transcripts
WHEN OLD.status = 'deleted' AND NEW.status <> 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_transcript_deleted');
END;

CREATE TABLE IF NOT EXISTS ai_audit_call_notes (
  id            text not null primary key,
  tenant_id     text not null,
  engagement_id text not null,
  question_id   text not null,
  notes         text not null default '',
  row_version   integer not null default 1,
  updated_by    text,
  created_at    text not null,
  updated_at    text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_call_notes_question_uq
  ON ai_audit_call_notes (tenant_id, engagement_id, question_id);

ALTER TABLE ai_audit_engagements ADD COLUMN call_started_at text;
ALTER TABLE ai_audit_engagements ADD COLUMN call_ended_at text;
