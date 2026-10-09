-- bravo__205_tenant_integration_checks.sql
--
-- The latest Test of each workspace app whose details OASIS sets on its own
-- server, one row per (workspace, app) (PR #553 review F1, 2026-10-08).
--
-- WHY. A Test of an app whose details OASIS sets on its own server (OASIS's
-- own workspaces: the Telegram team bot, the Google mailbox, Twilio) had
-- nowhere to land. app/api/integrations/keys/test records a result only on the
-- saved key rows (tenant_integration_credentials), and server-set values have
-- none, so the card could never say "verified" and a failed Test showed
-- nothing. The Test route writes its result here only when some value it
-- tested came from OASIS's server (never for a client workspace, which has no
-- server values); the card (lib/os/connectors.ts keyedStatus) reads it only
-- for the server-set values, since a saved value carries its own result.
--
-- A RESULT DESCRIBES THE VALUES IT TESTED, AND ONLY THOSE. Saving or removing
-- a value deletes the row (app/api/integrations/keys). A value changed on
-- OASIS's server (a rotated Worker secret) is caught by values_fingerprint:
-- a keyed fingerprint (HMAC-SHA256, lib/integrations/server-checks.ts) of the
-- server's values for that app when the Test ran. When the server's values no
-- longer match it, the card ignores the result and says the details changed
-- since the last Test, a pass or a failure alike (PR #558 review).
--
-- WHAT IT HOLDS. Whether the check passed, when, the failed check's code (the
-- card turns it into plain words) and the fingerprint. Never a key, a value or
-- a provider reply: the fingerprint is keyed with a server secret and cannot
-- be turned back into a value.
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
  tenant_id          TEXT NOT NULL,
  service            TEXT NOT NULL,
  checked_at         TEXT NOT NULL,
  ok                 INTEGER NOT NULL,
  code               TEXT,
  checked_by         TEXT,
  values_fingerprint TEXT,
  PRIMARY KEY (tenant_id, service)
);
