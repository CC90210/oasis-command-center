-- 228 - Public booking: a daily cap per visitor (2026-10-16).
--
-- Since #667 a calendar slot can be booked right after the contact step,
-- one step instead of four, and every booking is a real Google event that
-- invites CC. The booking POST's own rate limit (lib/rate-limit.ts) is per
-- Worker isolate and in memory: it slows a burst but never caps a day.
--
-- ONE ROW PER BOOKING REQUEST that took a place: the request id the booking
-- saga already keys on, the visitor (a hash of the request's IP address,
-- never the address itself; a request with no address is one shared key, so
-- it cannot slip past) and the UTC day. A visitor's places today are their
-- rows today. Keyed by request, so a retry of the same booking finds its own
-- row instead of taking a second place.
--
-- A booking takes a place with one atomic statement (INSERT ... SELECT ...
-- WHERE the visitor holds fewer than the cap), so two requests racing cannot
-- both take the last place; a booking that fails before Google was called
-- deletes its row (lib/forms/public-booking-cap.ts).
--
-- Additive only: one new table and its index, nothing existing touched. Rows
-- older than a week are pruned by the claim itself.

CREATE TABLE IF NOT EXISTS public_booking_claims (
  tenant_id   text not null,
  request_id  text not null,
  visitor_key text not null,
  day         text not null,
  created_at  text not null,
  primary key (tenant_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_public_booking_claims_visitor_day
  ON public_booking_claims (tenant_id, visitor_key, day);
