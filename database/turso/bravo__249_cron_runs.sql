-- bravo__249_cron_runs.sql (2026-10-28)
--
-- What each scheduled route did, as the cron Worker saw it (Phase 7 of the
-- Command Center refactor: Automations flow cards show the last run of every
-- schedule, and "not measured yet" until one is recorded).
--
-- workers/oasis-cc-cron posts one batch per tick to POST /api/cron/runs
-- (lib/automations/cron-runs.ts), behind the same two-leg cron auth as every
-- cron route. Platform-wide, not a workspace's: the routes are OASIS's own.
-- Rows older than 14 days are pruned by the same route.
--
--   route         the scheduled path, exactly as in the Worker's CRON_TABLE
--   tick_at       the minute the schedule fired (ISO, UTC)
--   ok            1 when the route answered 2xx (after at most one retry)
--   http_status   the status, or "error: ..." when no answer came
--   attempts      1, or 2 after a transient failure
--   duration_ms   from the first call to the final answer
--
-- Additive only.

CREATE TABLE IF NOT EXISTS cron_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  route TEXT NOT NULL,
  tick_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_route_tick ON cron_runs (route, tick_at);

CREATE INDEX IF NOT EXISTS idx_cron_runs_tick ON cron_runs (tick_at);
