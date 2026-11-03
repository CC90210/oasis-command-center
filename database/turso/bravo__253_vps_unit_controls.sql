-- bravo__253_vps_unit_controls.sql (2026-11-03)
--
-- CC's on/off switch for each always-on worker on the daemon VPS
-- (Automations > Background workers > 24/7 cloud workers). CC, 11-03: "for the
-- background workers i'm unable to like turn them off and on which is like not
-- good". A worker with no row is left exactly as systemd has it; Start, Stop
-- or Restart on the panel writes its row.
--
-- The VPS applies the rows itself: a root timer on the box
-- (BEA scripts/ops/vps_unit_control.py, deploy/oasis-unit-control.timer, every
-- 30 s) fetches them over the signed /api/internal/vps-control route and runs
-- systemctl on its own allowlisted units. The Command Center never reaches
-- into the server; the server only ever acts on these rows.
--
-- Platform-wide, like cron_job_switches: these are OASIS's own servers.
--
--   service              the integrations_health key ("vps.oasis-scheduler"),
--                        one of lib/automations/vps-health.ts VPS_HEALTH_SERVICES
--   desired              'on' or 'off'; OFF is held: the server stops the unit
--                        again whenever it finds it running
--   changed_at           when CC last switched it (ISO, UTC); the server acts
--                        once per changed_at for ON
--   changed_by           the auth user id that switched it
--   restart_requested_at the last Restart CC asked for (ISO, UTC), acted on once
--   applied_at           when the server last reported acting on this row
--   applied_for          the changed_at or restart stamp that report answers
--   applied_ok           1 = systemctl succeeded, 0 = it failed
--   applied_detail       the server's one-line account (never a secret)
--
-- Additive only.

CREATE TABLE IF NOT EXISTS vps_unit_controls (
  service TEXT PRIMARY KEY,
  desired TEXT NOT NULL CHECK (desired IN ('on', 'off')),
  changed_at TEXT NOT NULL,
  changed_by TEXT,
  restart_requested_at TEXT,
  applied_at TEXT,
  applied_for TEXT,
  applied_ok INTEGER CHECK (applied_ok IS NULL OR applied_ok IN (0, 1)),
  applied_detail TEXT
);
