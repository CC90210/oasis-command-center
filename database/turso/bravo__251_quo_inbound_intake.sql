-- bravo__251_quo_inbound_intake.sql (2026-10-28)
--
-- Proof that Quo's inbound webhook reaches OASIS (app/api/webhooks/quo): one
-- row per workspace, written only by a delivery whose signature verified.
-- Automated texts (the founder-meeting reminders) promise "Reply STOP to opt
-- out", so they stay off until this row shows a verified, readable
-- message.received (lib/integrations/quo.ts quoStopIntakeConnected).
--
--   last_verified_at    any delivery whose signature verified
--   last_event_type     its type ("message.received", ...)
--   last_event_id       its id, for tracing
--   last_inbound_at     a verified message.received whose sender and text read
--   last_inbound_to     the OASIS number that text reached: texts are opened
--                       only for THAT sending number
--   last_stop_at        the last STOP put on the STOP list from a Quo reply
--
-- Additive only. No comment after a semicolon on the same line (the applier
-- splits on ';' plus newline).

-- quo_inbound_consent: the newest STOP/START seen per number, so a retried
-- or late older delivery never overrides a newer choice (Quo retries and does
-- not promise order). A replay of the SAME delivery (same webhook id) is
-- allowed through so a failed write can finish.

CREATE TABLE IF NOT EXISTS quo_inbound_consent (
  tenant_id         TEXT NOT NULL,
  phone_last10      TEXT NOT NULL,
  last_event_at     TEXT NOT NULL,
  last_action       TEXT NOT NULL,
  last_webhook_id   TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (tenant_id, phone_last10)
);

CREATE TABLE IF NOT EXISTS quo_inbound_health (
  tenant_id         TEXT PRIMARY KEY,
  last_verified_at  TEXT NOT NULL,
  last_event_type   TEXT,
  last_event_id     TEXT,
  last_inbound_at   TEXT,
  last_inbound_to   TEXT,
  last_stop_at      TEXT,
  updated_at        TEXT NOT NULL
);
