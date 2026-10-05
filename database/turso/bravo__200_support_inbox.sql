-- bravo__200_support_inbox.sql
--
-- support@oasisai.work becomes a way into the support desk. A reader on CC's
-- PC (BEA, scripts/support/) reads the mailbox, classifies each message and
-- posts it, HMAC-signed, to POST /api/internal/support/ingest. The Command
-- Center owns everything after that: the ticket, the instant acknowledgement,
-- the thread, the reply draft's approval and every email a client receives
-- (lib/delivery/email-intake.ts).
--
-- support_email_messages: one row per message, both directions.
--   inbound   every message the reader posted, ticket or not. The row is the
--             CLAIM: it is written before anything else, keyed on
--             (tenant_id, direction, message_id_hash), so a message posted
--             twice is handled once, and a retry finishes the plan the first
--             attempt wrote (plan_json) instead of making a second ticket.
--   outbound  the acknowledgement and every reply the desk sends, so a
--             client's answer to them threads back onto the same ticket.
--   message_id_hash is sha256 of the Message-ID exactly as sent ("<id>"), or,
--   for a message with none, of received_at, sender, subject and text joined
--   by newlines: the same key the reader dedupes on.
--   content_hash (inbound) is sha256 of the sender, subject and text: the same
--   key with other content is refused (409), never filed over the first.
--   The message TEXT is not stored here. It lives on the ticket (its
--   description or a comment), which is the business record; this row keeps
--   routing facts, verdicts and outcomes only.
--
-- support_mailbox_status: the reader's heartbeat, one row per mailbox. It
--   says when support@ was last read; the SLA cron alerts once when it has not
--   been read for 20 minutes (lib/delivery/support-inbox-health.ts).
--   signed_at is the reader's signed timestamp (x-support-timestamp, unix
--   seconds, inside the HMAC) of the heartbeat the row holds: a heartbeat is
--   kept only when its signed time is NEWER, so a replayed or late one can
--   never overwrite a newer failure.
--
-- ticket_comments.channel: how a comment arrived (email, portal, form).
--   Nullable; every existing comment keeps working.
--
-- ORDERING. Additive only. The code that ships with this file answers 503
-- not_installed while these tables are missing, and the reader retries, so it
-- can be applied before or after the deploy.
--
-- NOT RE-RUNNABLE AS A WHOLE: SQLite has no ADD COLUMN IF NOT EXISTS. The
-- migration ledger (scripts/apply_turso_migration.py) applies it once; every
-- CREATE is IF NOT EXISTS, so a run that stopped part way can be finished.
--
-- No CHECK constraints on the enum columns, as in migration 183: the allowed
-- values live once, in lib/delivery/email-intake.ts and lib/delivery/rules.ts.

CREATE TABLE IF NOT EXISTS support_email_messages (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  direction           TEXT NOT NULL,
  mailbox             TEXT NOT NULL,
  delivered_to        TEXT,
  origin              TEXT,
  message_id          TEXT,
  message_id_hash     TEXT NOT NULL,
  content_hash        TEXT,
  in_reply_to         TEXT,
  references_json     TEXT NOT NULL DEFAULT '[]',
  from_address        TEXT,
  to_json             TEXT NOT NULL DEFAULT '[]',
  cc_json             TEXT NOT NULL DEFAULT '[]',
  subject             TEXT,
  ticket_id           TEXT,
  comment_id          TEXT,
  disposition         TEXT,
  plan_json           TEXT,
  sender_verified     INTEGER NOT NULL DEFAULT 0,
  auth_json           TEXT,
  auto_submitted      INTEGER NOT NULL DEFAULT 0,
  forwarded_by        TEXT,
  is_support_request  INTEGER,
  non_ticket_kind     TEXT,
  facet               TEXT,
  urgency             TEXT,
  confidence          REAL,
  fallback            INTEGER NOT NULL DEFAULT 0,
  opt_out             INTEGER NOT NULL DEFAULT 0,
  model_ref           TEXT,
  ack_wanted          INTEGER NOT NULL DEFAULT 0,
  ack_status          TEXT,
  acked_at            TEXT,
  draft_wanted        INTEGER NOT NULL DEFAULT 0,
  draft_status        TEXT,
  draft_approval_id   TEXT,
  draft_failure       TEXT,
  attachments_json    TEXT NOT NULL DEFAULT '[]',
  body_truncated      INTEGER NOT NULL DEFAULT 0,
  received_at         TEXT NOT NULL,
  ingested_at         TEXT NOT NULL,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The claim: one row per message and direction on a desk.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sem_tenant_direction_hash
  ON support_email_messages (tenant_id, direction, message_id_hash);

-- A ticket's messages, oldest first (threading, the reply's headers, staleness).
CREATE INDEX IF NOT EXISTS idx_sem_tenant_ticket_received
  ON support_email_messages (tenant_id, ticket_id, received_at);

-- The drafts the reader is asked to write.
CREATE INDEX IF NOT EXISTS idx_sem_tenant_drafts
  ON support_email_messages (tenant_id, draft_wanted, draft_status, received_at);

-- One sender's recent messages (per-sender limits, the subject heuristic).
CREATE INDEX IF NOT EXISTS idx_sem_tenant_sender
  ON support_email_messages (tenant_id, from_address, received_at);

CREATE TRIGGER IF NOT EXISTS support_email_messages_tenant_immutable
BEFORE UPDATE OF tenant_id ON support_email_messages
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'support_email_messages.tenant_id is immutable');
END;

CREATE TABLE IF NOT EXISTS support_mailbox_status (
  tenant_id             TEXT NOT NULL,
  mailbox               TEXT NOT NULL,
  producer              TEXT NOT NULL,
  phase                 TEXT,
  ok                    INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  last_sweep_at         TEXT NOT NULL,
  reported_at           TEXT,
  last_ok_at            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  counts_json           TEXT NOT NULL DEFAULT '{}',
  alerted_at            TEXT,
  alert_status          TEXT,
  signed_at             INTEGER,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, mailbox)
);

CREATE TRIGGER IF NOT EXISTS support_mailbox_status_tenant_immutable
BEFORE UPDATE OF tenant_id ON support_mailbox_status
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'support_mailbox_status.tenant_id is immutable');
END;

ALTER TABLE ticket_comments ADD COLUMN channel TEXT;
