-- 230 - Oasis Meet: our own meeting rooms (2026-10-17).
--
-- CC: "We're doing our own Google Meet ... just going to be hosting private
-- meetings", started from the Schedule page, joined by a link. Media runs
-- through Cloudflare Realtime (the SFU); these two tables are the room and who
-- is in it. Recordings and transcripts have their own tables (their own
-- migration).
--
-- meet_rooms: one row per meeting. `code` is the link (oasisai.work/meet/
-- abc-defg-hjk): ten random letters, stored without the dashes, unique, never
-- reused. The code is the capability a guest holds, so it is the one lookup
-- that is not by tenant; everything after it uses the room's own tenant_id.
-- A room is `scheduled` until a host first joins, `live` from then, `ended`
-- when a host ends it or leaves it unattended (ended_reason says which).
-- record_audio is the host's choice. calendar_event_id and lead_id link it to
-- the Schedule and the CRM; deleting a lead unlinks a meeting, never deletes it.
--
-- meet_participants: one row per person per join. A guest has no user_id. A
-- host is a signed-in member of the room's workspace. consent_at is when the
-- person ticked the recording notice, kept as the record of it. sfu_session_id
-- is their Cloudflare Realtime session and `tracks` what they publish (JSON).
-- left_at and removed_at end a participant: every call a participant makes
-- re-reads this row, so a removal takes effect on their next request.
--
-- Additive only: two new tables and their indexes, nothing existing touched.

CREATE TABLE IF NOT EXISTS meet_rooms (
  id                text not null primary key,
  tenant_id         text not null,
  code              text not null,
  title             text not null,
  host_user_id      text not null,
  status            text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  record_audio      integer not null default 1 check (record_audio in (0, 1)),
  starts_at         text,
  calendar_event_id text,
  lead_id           text,
  created_at        text not null,
  started_at        text,
  ended_at          text,
  ended_reason      text check (ended_reason is null or ended_reason in ('host_ended', 'host_left', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meet_rooms_code ON meet_rooms (code);
CREATE INDEX IF NOT EXISTS idx_meet_rooms_tenant_created ON meet_rooms (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_meet_rooms_tenant_lead ON meet_rooms (tenant_id, lead_id);

CREATE TABLE IF NOT EXISTS meet_participants (
  id             text not null primary key,
  tenant_id      text not null,
  room_id        text not null,
  role           text not null check (role in ('host', 'guest')),
  user_id        text,
  display_name   text not null,
  consent_at     text,
  sfu_session_id text,
  tracks         text not null default '[]',
  joined_at      text not null,
  last_seen_at   text not null,
  left_at        text,
  removed_at     text
);

CREATE INDEX IF NOT EXISTS idx_meet_participants_room ON meet_participants (tenant_id, room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meet_participants_session ON meet_participants (sfu_session_id);
