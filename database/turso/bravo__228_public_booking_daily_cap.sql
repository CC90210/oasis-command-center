-- 228 - Public booking: a daily cap per visitor (2026-10-16).
--
-- Since #667 a calendar slot can be booked right after the contact step,
-- one step instead of four, and every booking is a real Google event that
-- invites CC. The booking POST's own rate limit (lib/rate-limit.ts) is per
-- Worker isolate and in memory: it slows a burst but never caps a day.
--
-- ONE ROW PER WORKSPACE, VISITOR AND UTC DAY. `visitor_key` is a hash of the
-- request's IP address (never the address itself; a request with no address
-- is one shared key, so it cannot slip past). `count` is how many calls that
-- visitor holds today. A booking claims a place with one atomic statement
-- (INSERT ... ON CONFLICT DO UPDATE ... WHERE count < cap RETURNING), so two
-- requests racing cannot both take the last place, and a booking that fails
-- gives its place back (lib/forms/public-booking-cap.ts).
--
-- Additive only: one new table, nothing existing touched. Rows older than a
-- week are pruned by the claim itself.

CREATE TABLE IF NOT EXISTS public_booking_daily_claims (
  tenant_id   text not null,
  visitor_key text not null,
  day         text not null,
  count       integer not null default 0,
  updated_at  text not null,
  primary key (tenant_id, visitor_key, day)
);
