-- bravo__248_agent_state_snapshot_reporter.sql (2026-10-28)
--
-- Which computer carried an agent's latest heartbeat (Codex review of Command
-- Center #769). Admin > Fleet judges "computer silent" on THAT pairing: with two
-- paired computers, the one still checking in must not make the silent one's
-- stale agents read as merely quiet.
--
--   reported_by_pairing_id   bridge_pairings.id of the computer whose ping
--                            carried the tick (app/api/bridge/ping ->
--                            lib/bridge/fleet-ticks.ts recordAgentTicks).
--                            NULL for rows no dashboard heartbeat has written.
--
-- A new column, not last_tick_id: that one holds the agent's own tick id
-- (scripts/core/agent_heartbeat.py) and /operations prints it.
--
-- Additive only.

ALTER TABLE agent_state_snapshot ADD COLUMN reported_by_pairing_id TEXT;
