-- bravo__190_agent_turn_outcomes.sql — each chat channel's LAST turn, ok or
-- with its failure code (OASIS OS plan v2 §F1.2 "Channels honest", 2026-09-29).
--
-- WHY. A department channel's header said "Working" whenever a key was on
-- file, including a key the provider was refusing (a drained balance answers
-- 400, OpenRouter with no credits answers 402). app/api/agents/chat now records
-- every turn's outcome here and the department page reads it, so the header
-- says "Not working: AI account refused the request (check billing)" until a
-- turn succeeds again. Read and written only by lib/os/channel/turns.ts.
--
-- ONE ROW PER CHANNEL, upserted: the table is the size of the channel list,
-- not of the conversation. A full per-turn history is the Business Ledger's job
-- (plan §F2 outcome_events), not this table's.
--
-- channel_key  'dept:<department key>' for a department channel,
--              'agent:<agent slug>' for a direct agent chat (lib/os/channel/outcome.ts).
-- outcome      'ok' | 'failed'.
-- code         the failure code when outcome = 'failed' (TURN_FAILURE_CODES in
--              lib/os/channel/outcome.ts); NULL when ok. No provider text, no
--              message content, no secrets: a code only.
-- at           ISO-8601 UTC written by the app. The upsert keeps the newer of
--              two racing turns (WHERE excluded.at >= agent_turn_outcomes.at).
--
-- CONVENTIONS (from 183_delivery_and_support.turso.sql):
--   * tenant_id TEXT NOT NULL, and the primary key and every index LEAD with
--     it. libSQL has no row-level security: the tenant id in every statement in
--     lib/os/channel/turns.ts, taken from the session, IS the boundary.
--   * NO CHECK constraints on the enum columns; the values live once, in
--     lib/os/channel/outcome.ts, where tests/os-channels-honest.test.ts pins them.
--   * Additive only.
--
-- ORDERING. The code that ships with this file treats a missing table as "not
-- recorded yet": a write logs once and records nothing, and the page judges
-- readiness by the key alone, as before. Safe to apply before or after deploy.

CREATE TABLE IF NOT EXISTS agent_turn_outcomes (
  tenant_id    TEXT NOT NULL,
  channel_key  TEXT NOT NULL,
  agent_slug   TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  code         TEXT,
  at           TEXT NOT NULL,
  PRIMARY KEY (tenant_id, channel_key)
);

-- The department page: this workspace's channels, newest first.
CREATE INDEX IF NOT EXISTS idx_agent_turn_outcomes_tenant_at
  ON agent_turn_outcomes (tenant_id, at);

-- A row never changes tenant.
CREATE TRIGGER IF NOT EXISTS agent_turn_outcomes_tenant_immutable
BEFORE UPDATE OF tenant_id ON agent_turn_outcomes
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'agent_turn_outcomes.tenant_id is immutable');
END;
