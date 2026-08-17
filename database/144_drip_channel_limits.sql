-- 144 — the per-channel send ceilings get their own row. (Postgres form.)
--
-- Companion to database/turso/144_drip_channel_limits.turso.sql, which is the
-- one that has actually been APPLIED. Turso is the live data plane (cutover
-- 2026-08-09) and this file has deliberately not been run anywhere; it exists
-- so the two schemas stay in step, which is the convention set by 140-143.
--
-- WHY A TABLE INSTEAD OF THE JSON BLOB THIS STARTED IN. These four integers
-- were first kept on tenants.custom_fields.drip_limits to avoid a migration.
-- That column is shared with other product features, so every write was a
-- read-modify-write over data owned by someone else, and three attempts to make
-- it safe each introduced a subtler bug. The last could not work at all: the
-- adapter parses JSON on read, so a compare-and-swap token was a re-serialised
-- object rather than the stored text, and any row whose formatting differed
-- would never match. The problem was never the locking, it was sharing a cell.

BEGIN;

CREATE TABLE IF NOT EXISTS public.drip_channel_limits (
  tenant_id            uuid PRIMARY KEY REFERENCES public.tenants (id) ON DELETE CASCADE,
  -- NULL means "not set here" and falls through to env, then to the built-in
  -- default. Deliberately distinct from 0, which means stopped.
  sms_daily            integer,
  sms_hourly           integer,
  email_daily_sunbiz   integer,
  email_daily_bluerise integer,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- PII: none. This table holds four integers and a tenant reference, so it
-- carries no personal data and the RLS-on-PII rule does not apply. Access is
-- service-role only, same as every other drip table.
ALTER TABLE public.drip_channel_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drip_channel_limits_service ON public.drip_channel_limits;
CREATE POLICY drip_channel_limits_service ON public.drip_channel_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.drip_channel_limits FROM anon, authenticated;

-- BACKFILL from the blob this replaces.
--
-- A migration that abandons the old storage must carry the values across, and
-- the specific danger is worth naming: a stored 0 meant STOPPED, so reverting
-- it to a positive default would resume sending on a channel somebody had
-- deliberately halted.
--
-- Verified against bravo-empire before applying: zero tenants had
-- custom_fields.drip_limits, because the blob-backed code never merged to main.
-- So this carried nothing here. It stays because the same migration runs
-- elsewhere, and "it happened to be empty" is not a property of a migration.
--
-- Keys are camelCase in the blob (what the old save wrote), snake_case here.
INSERT INTO "drip_channel_limits"
  ("tenant_id", "sms_daily", "sms_hourly", "email_daily_sunbiz", "email_daily_bluerise")
SELECT
  "id",
  (custom_fields #>> '{drip_limits,smsDaily}')::int,
  (custom_fields #>> '{drip_limits,smsHourly}')::int,
  (custom_fields #>> '{drip_limits,emailDailySunbiz}')::int,
  (custom_fields #>> '{drip_limits,emailDailyBluerise}')::int
FROM "tenants"
WHERE "custom_fields" IS NOT NULL
    AND custom_fields ? 'drip_limits'
ON CONFLICT("tenant_id") DO NOTHING;

COMMIT;
