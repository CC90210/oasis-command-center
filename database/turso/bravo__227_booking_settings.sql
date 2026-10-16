-- 227 - Booking settings: who takes booked calls, and when (2026-10-16).
--
-- CC, 2026-10-15: warm inbound leads book straight onto the Schedule's
-- "Meetings" calendar, only when the team is free. Before this, the public
-- booking engine (lib/forms/public-booking.ts, PR #611) hard-coded Mon-Fri
-- 09:00-17:00 Toronto, read only the founders' Google calendars, and copied
-- every booking into each founder's DEFAULT calendar.
--
-- ONE ROW PER WORKSPACE. `doc` is a JSON document parsed by
-- lib/booking/hours.ts parseBookingSettings (time zone, slot step, notice,
-- horizon, buffer, and the hosts: each host's weekly hours, role and the
-- Schedule calendar their bookings land on). A row that fails to parse makes
-- availability fail closed; it never falls back to guessed hours.
--
-- CONCURRENT EDITORS. Saved compare-and-swap on `version`: a save that read
-- version 3 lands only while the row is still at 3.
--
-- A workspace with no row uses the built-in default (lib/booking/hours.ts
-- defaultOasisBookingSettings, OASIS only), so this migration changes nothing
-- until someone saves. Additive only: one new table, nothing existing touched.

CREATE TABLE IF NOT EXISTS booking_settings (
  tenant_id   text primary key,
  doc         text not null,
  version     integer not null default 1,
  updated_at  text not null,
  updated_by  text
);
