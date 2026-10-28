-- bravo__250_cron_runs_unique_tick.sql (2026-10-28)
--
-- One row per route per tick (CodeRabbit on Command Center #772). A second
-- report of the same scheduled tick (a double-fired invocation) used to insert
-- a second row, which the 24-hour counts then counted twice.
-- lib/automations/cron-runs.ts inserts with OR IGNORE, so the first report of a
-- tick is kept. bravo__249 is already applied, so the fix is a new file.
-- cron_runs held no rows when this was written: the Worker that fills it was
-- not yet deployed.
--
-- Additive only.

CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_route_tick_unique ON cron_runs (route, tick_at);
