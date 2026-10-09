-- bravo__205_tenant_integration_checks.sql
--
-- The latest Test of each workspace app, one row per (workspace, app)
-- (PR #553 review F1, 2026-10-08).
--
-- WHY. A Test of an app whose details OASIS sets on its own server (OASIS's
-- own workspaces: the Telegram team bot, the Google mailbox, Twilio) had
-- nowhere to land. app/api/integrations/keys/test records a result only on the
-- saved key rows (tenant_integration_credentials), and server-set values have
-- none, so the card could never say "verified" and a failed Test showed
-- nothing. The Test route writes its result here as well, for every app; the
-- card (lib/os/connectors.ts keyedStatus) reads it only for the server-set
-- values, since a saved value carries its own result. Saving or removing a
-- value deletes the row (app/api/integrations/keys), so a result always
-- describes the values in use.
--
-- WHAT IT HOLDS. Whether the check passed, when, and the failed check's code
-- (the card turns it into plain words). Never a key, a value or a provider
-- reply.
--
-- CONVENTIONS (database/turso/183_delivery_and_support.turso.sql)
--   * tenant_id TEXT NOT NULL; the WHERE tenant_id = ? in
--     lib/integrations/server-checks.ts, taken from the session, is the
--     isolation boundary.
--   * timestamps are ISO-8601 UTC strings; ok is 0 or 1.
--   * no CHECK constraint on service or code: the values live in
--     lib/tenant-integration-schemas.ts and the Test route.
--   * Additive only, no BEGIN/COMMIT (the Turso runner applies statements one at
--     a time and is not transactional).
--
-- ORDERING. The code that ships with this file reads a missing table as "no
-- check recorded yet" (the card says "not tested yet", as it did before), and
-- the Test route then tells the owner its result could not be saved. Safe to
-- apply before or after deploy.

CREATE TABLE IF NOT EXISTS tenant_integration_checks (
  tenant_id   TEXT NOT NULL,
  service     TEXT NOT NULL,
  checked_at  TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  code        TEXT,
  checked_by  TEXT,
  PRIMARY KEY (tenant_id, service)
);
