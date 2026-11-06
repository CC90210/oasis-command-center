-- bravo__254_notification_log.sql — every automation notification, for the Command Center.
--
-- CC (2026-11-05): "make sure all the automation notifications are also displayed
-- on the OasisAI command center." Telegram is the curated push; this table is the
-- complete record the Automations page shows (lib/notify/notification-log.ts).
--
-- One row per notice that Bravo, Maven, Atlas or the Command Center itself sent, or
-- tried to send, to CC. `agent` is who the notice belongs to; `bridge` is whose bot
-- actually carried it (they differ when an agent's own bot is not set up where the
-- notice was raised); `delivered` is whether Telegram accepted it, and `detail` says
-- why not. Written best-effort by each sender, never blocking the send.
--
-- Lifecycle: kept 90 days, pruned by /api/cron/connection-health
-- (purgeNotificationLog), beside the Slack and client-error retention.
CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('bravo', 'maven', 'atlas', 'command_center')),
  category TEXT,
  title TEXT NOT NULL,
  body TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'urgent')),
  bridge TEXT CHECK (bridge IS NULL OR bridge IN ('bravo', 'maven', 'atlas', 'command_center')),
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
  detail TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_log_tenant_created
  ON notification_log (tenant_id, created_at DESC);
