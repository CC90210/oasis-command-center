-- bravo__251_cron_job_switches.sql (2026-10-31)
--
-- CC's on/off switch for each scheduled cloud job (Automations > 24/7 cloud
-- automations). A job with no row is ON; flipping a switch writes its row.
-- Every scheduled route reads its own row right after the cron auth check
-- (lib/automations/cron-switches.ts cronPauseGate) and, while it is OFF,
-- answers 200 "paused" without doing any work.
--
-- Platform-wide, like cron_runs: the routes are OASIS's own.
--
--   route        the scheduled path, exactly as in the Worker's CRON_TABLE
--   enabled      1 = runs on schedule, 0 = paused
--   changed_at   when the switch last changed (ISO, UTC)
--   changed_by   the auth user id that changed it
--
-- Additive only.

CREATE TABLE IF NOT EXISTS cron_job_switches (
  route TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  changed_at TEXT NOT NULL,
  changed_by TEXT
);
