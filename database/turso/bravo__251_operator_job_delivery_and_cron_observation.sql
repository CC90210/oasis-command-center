-- bravo__251_operator_job_delivery_and_cron_observation.sql (2026-10-30)
--
-- Two small durability records for the cloud handover:
--
-- 1. operator_job_deliveries is the receipt/lease journal for an operator-only
--    scheduled notification. A unique delivery_key makes a Toronto calendar
--    day's morning brief one outward attempt. `claimed` may be reclaimed only
--    when its lease expired before attempt_started_at was written. Once an
--    attempt starts, a missing provider receipt becomes `delivery_unknown` and
--    requires operator review; an automatic retry must never send it again.
--
-- 2. cron_route_observations records when a deployed cron registry first
--    reported itself. It lets hourly health distinguish a genuinely new route
--    inside its first schedule-aware grace period from a route that has missed
--    its first due tick. It is platform-wide, like cron_runs.
--
-- Lifecycle: operator_job_deliveries is permanent outbound-delivery evidence
-- (one row per job/date, not a per-attempt log). cron_route_observations is
-- naturally bounded to one row per registered route; retired paths stay as
-- deployment evidence. Neither table has a recurring deletion sweep.
--
-- Deployment order: bravo__251 MUST be applied before deploying this code,
-- not merely before enabling the new routes. The existing cron-run recorder
-- reads and writes cron_route_observations on every Worker report regardless
-- of either new route's forwarding switch.

CREATE TABLE IF NOT EXISTS operator_job_deliveries (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  job_key            TEXT NOT NULL,
  delivery_key       TEXT NOT NULL,
  scheduled_for      TEXT NOT NULL,
  status             TEXT NOT NULL,
  claim_token        TEXT NOT NULL,
  lease_expires_at   TEXT,
  attempt_started_at TEXT,
  delivered_at       TEXT,
  provider_outcome   TEXT,
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_job_delivery_key
  ON operator_job_deliveries (tenant_id, delivery_key);

CREATE INDEX IF NOT EXISTS ix_operator_job_delivery_claim
  ON operator_job_deliveries (tenant_id, job_key, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS cron_route_observations (
  route       TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL
);
