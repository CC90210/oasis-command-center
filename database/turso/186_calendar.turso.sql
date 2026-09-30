-- 186 - Schedule: a personal, database-backed calendar (2026-09-29).
--
-- Replaces the browser-only weekly template the Schedule page kept in
-- localStorage (lib/schedule/model.ts). Events now follow the viewer across
-- devices and survive a cleared browser.
--
-- OWNERSHIP. Every row carries tenant_id AND user_id. A calendar is private
-- to the user who made it: every read and write in lib/calendar/store.ts
-- filters on both, and both lead every index, because Turso has no row-level
-- security and the filter IS the authorization boundary.
--
-- PII. calendar_events.guests, .description and .location can hold personal
-- data (names, addresses, email addresses). Nothing here is shared with
-- another user or sent anywhere: guests are recorded, never invited. Any
-- future feature that emails a guest must go through the one send gate.
--
-- TIME. Timed events store UTC ISO instants in start_at/end_at. All-day
-- events store local dates (YYYY-MM-DD) with an EXCLUSIVE end, the Google
-- Calendar / iCalendar convention. Recurring series: the master row carries
-- recurrence (JSON); an edited occurrence is its own row pointing back via
-- recurring_event_id + original_start; a deleted occurrence is listed in the
-- master's exdates (JSON array). libSQL returns booleans as 0/1 and JSON as
-- TEXT; the store converts both.
--
-- Additive only: three new tables, no existing table is touched.

CREATE TABLE IF NOT EXISTS calendar_calendars (
  id          text primary key,
  tenant_id   text not null,
  user_id     text not null,
  name        text not null,
  color       text not null,
  visible     integer not null default 1,
  is_default  integer not null default 0,
  position    integer not null default 0,
  created_at  text not null,
  updated_at  text not null
);

CREATE INDEX IF NOT EXISTS calendar_calendars_owner_idx
  ON calendar_calendars (tenant_id, user_id, position);

CREATE TABLE IF NOT EXISTS calendar_events (
  id                  text primary key,
  tenant_id           text not null,
  user_id             text not null,
  calendar_id         text not null,
  title               text not null default '',
  description         text not null default '',
  location            text not null default '',
  all_day             integer not null default 0,
  start_at            text not null,
  end_at              text not null,
  time_zone           text not null,
  recurrence          text,
  exdates             text not null default '[]',
  recurring_event_id  text,
  original_start      text,
  color               text,
  reminders           text not null default '[]',
  guests              text not null default '[]',
  busy                integer not null default 1,
  created_at          text not null,
  updated_at          text not null
);

CREATE INDEX IF NOT EXISTS calendar_events_owner_idx
  ON calendar_events (tenant_id, user_id, start_at);
CREATE INDEX IF NOT EXISTS calendar_events_calendar_idx
  ON calendar_events (tenant_id, user_id, calendar_id);
CREATE INDEX IF NOT EXISTS calendar_events_series_idx
  ON calendar_events (tenant_id, user_id, recurring_event_id);

CREATE TABLE IF NOT EXISTS calendar_prefs (
  id          text primary key,
  tenant_id   text not null,
  user_id     text not null,
  prefs       text not null,
  updated_at  text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_prefs_owner_uq
  ON calendar_prefs (tenant_id, user_id);
