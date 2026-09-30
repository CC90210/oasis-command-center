-- bravo__197_slack_jev.sql - Slack two-way agents and the Jev shadow log
-- (OASIS OS S2 track T8, 2026-09-30).
--
-- WHAT LIVES WHERE
--   slack_channel_routes   one row per Slack channel a workspace mapped: which
--                          department speaks there by default and, optionally,
--                          which client the channel is about. A channel mapped
--                          to a client mirrors its messages onto that client's
--                          Conversations tab. department NULL = a general
--                          channel: its messages are mirrored, and nobody
--                          answers them unless @mentioned.
--   external_identities    a person in a connected app (a Slack user) and, when
--                          their verified email matches a teammate in the SAME
--                          workspace, that teammate's profile. is_guest and
--                          is_external are what the events route drops on.
--                          Deleted on a Slack disconnect, and a row not
--                          re-checked for 90 days is deleted by retention.
--   slack_event_receipts   one row per Slack event_id processed: the dedupe for
--                          Slack's retries (x-slack-retry-num). Trimmed after a
--                          week by lib/slack/retention.ts.
--   jev_calls              Jev (TypeSafe System One) telemetry ONLY: which
--                          surface, which mode, how long, whether it agreed with
--                          the decision OASIS already made, token count. NO
--                          message text, no answer text, no key.
--
-- NOT HERE, ON PURPOSE
--   * Which Slack team belongs to which workspace: provider_webhook_routes
--     (bravo__187), provider 'slack', external_key = the Slack team id. Its
--     unique (provider, external_key) index is what keeps one Slack workspace
--     attached to ONE OASIS workspace.
--   * The mirrored messages: conversation_events, event_type 'slack_message',
--     metadata.channel = 'slack', metadata.thread_key =
--     'slack:<team>:<channel>:<thread_ts>', metadata.customer_id when the
--     channel is mapped to a client (lib/slack/events.ts). The client hub's
--     Conversations tab reads them from there. Purged after 90 days by
--     lib/slack/retention.ts.
--   * The bot token: tenant_integration_credentials, service
--     'connection:<tenant_connections.id>', field 'bot_token', encrypted
--     (lib/connections/token-store.ts saveBotToken).
--
-- CONVENTIONS (database/turso/183_delivery_and_support.turso.sql)
--   * tenant_id TEXT NOT NULL on every table; tenant indexes lead with it. The
--     WHERE tenant_id = ? in lib/slack/*.ts, taken from the resolved route or
--     session, IS the isolation boundary.
--   * ids are TEXT written by the app; timestamps are ISO-8601 UTC strings.
--   * NO CHECK constraints on enum columns (department, provider, surface,
--     mode, outcome); the values live in lib/slack/routing.ts and
--     lib/jev/mode.ts, where tests pin them.
--   * Additive only.
--
-- ORDERING. The code that ships with this file answers a missing table as
-- "not installed": Settings > Chat apps says so, the events route refuses to
-- process (Slack retries), and the retention sweep reports not_installed. Safe
-- to apply before or after deploy.

CREATE TABLE IF NOT EXISTS slack_channel_routes (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  channel_name  TEXT,
  department    TEXT,
  customer_id   TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One route per channel PER WORKSPACE. Which workspace a Slack team's events
-- reach is provider_webhook_routes' job (one live workspace per team); every
-- read here is by that tenant. Keyed across tenants instead, a workspace that
-- installed a Slack team another workspace had used before could never map
-- that team's channels (the old rows would hold them). A Slack disconnect
-- deletes the workspace's rows anyway (lib/slack/routing.ts
-- slackDisconnectStatements).
CREATE UNIQUE INDEX IF NOT EXISTS ux_slack_channel_routes_tenant_channel
  ON slack_channel_routes (tenant_id, team_id, channel_id);

CREATE INDEX IF NOT EXISTS idx_slack_channel_routes_tenant
  ON slack_channel_routes (tenant_id, department);

CREATE TRIGGER IF NOT EXISTS slack_channel_routes_tenant_immutable
BEFORE UPDATE OF tenant_id ON slack_channel_routes
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'slack_channel_routes.tenant_id is immutable');
END;

CREATE TABLE IF NOT EXISTS external_identities (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  provider           TEXT NOT NULL,
  external_team_id   TEXT,
  external_user_id   TEXT NOT NULL,
  display_name       TEXT,
  profile_id         TEXT,
  is_guest           INTEGER NOT NULL DEFAULT 0,
  is_external        INTEGER NOT NULL DEFAULT 0,
  checked_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_external_identities_user
  ON external_identities (tenant_id, provider, external_user_id);

CREATE TRIGGER IF NOT EXISTS external_identities_tenant_immutable
BEFORE UPDATE OF tenant_id ON external_identities
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'external_identities.tenant_id is immutable');
END;

CREATE TABLE IF NOT EXISTS slack_event_receipts (
  event_id     TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  team_id      TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_event_receipts_received
  ON slack_event_receipts (received_at);

CREATE TABLE IF NOT EXISTS jev_calls (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  surface       TEXT NOT NULL,
  mode          TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  latency_ms    INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  agreed        INTEGER CHECK (agreed IS NULL OR agreed IN (0, 1)),
  input_tokens  INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jev_calls_tenant_created
  ON jev_calls (tenant_id, created_at);
