-- bravo__187_os_connections.sql
-- OASIS OS Connections framework: connection STATE, single-use OAuth state,
-- health history and webhook routing (docs/os-revamp/03 §(a) a.2, 2026-09-28).
--
-- WHAT LIVES WHERE
--   tenant_connections        one row per connected account: which provider,
--                             which external account (acct_ / realmId / ...),
--                             status, health, refresh lease. At most ONE live
--                             row per provider per tenant (per user for user
--                             scope): ux_tenant_connections_one_live. NO SECRETS. The
--                             credential itself stays in
--                             tenant_integration_credentials (service
--                             'connection:<tenant_connections.id>'), encrypted
--                             by lib/field-encryption, read and written only
--                             through lib/tenant-integration-store.
--   oauth_states              one row per started OAuth consent. Single-use:
--                             the callback consumes it with
--                             UPDATE ... SET consumed_at = ? WHERE nonce = ?
--                             AND consumed_at IS NULL, which must affect
--                             exactly one row (closes the Constant Contact
--                             15-minute replay window, doc 03 F7).
--   connection_health_checks  append-only probe history, trimmed to 30 days by
--                             /api/cron/connection-health.
--   provider_webhook_routes   external key (acct_ / page_id / realmId / ...)
--                             -> the ONE tenant and connection it belongs to.
--
-- CONVENTIONS (database/turso/183_delivery_and_support.turso.sql)
--   * Every table has tenant_id TEXT NOT NULL; every tenant index LEADS with
--     tenant_id. libSQL has no row-level security, so the WHERE tenant_id = ?
--     in lib/connections/store.ts IS the isolation boundary.
--   * ids are TEXT written by the app (crypto.randomUUID()).
--   * Timestamps are ISO-8601 UTC strings written by the app
--     (new Date().toISOString()), so freshness checks are string compares.
--   * NO CHECK constraints on the enum columns (status, verdict, auth_kind,
--     scope_kind, environment, check_source, error codes). The allowed values
--     live once, in lib/connections/rules.ts, where tests pin them.
--   * Additive only. Nothing here drops or rewrites an existing object.
--
-- TWO DELIBERATE EXCEPTIONS TO "indexes lead with tenant_id", both uniqueness
-- guarantees that must hold ACROSS tenants and therefore cannot be scoped to
-- one:
--   ux_tenant_connections_exclusive_account  one Stripe / QuickBooks / Xero /
--       Plaid / Meta / Twilio account can be live in at most ONE tenant, so one
--       company's money can never feed two tenants' books (doc 03 F6). The
--       provider list is EXCLUSIVE_PROVIDERS in lib/connections/rules.ts;
--       tests/os-connections.test.ts asserts the two lists are equal.
--   ux_provider_webhook_routes_key  a webhook carries no session, so its
--       external key must resolve to exactly one tenant.

-- ── tenant_connections ─────────────────────────────────────────────────────
-- status: pending | connected | degraded | expired | revoked | error | pending_review
-- last_health_verdict: healthy | degraded | down | unknown
-- auth_kind: oauth2 | restricted_key | api_key | system_user | app_install | bank_link | nango
-- scope_kind: tenant | user (user_id is set only for 'user')
-- environment: live | test, or NULL for a provider with no such split
CREATE TABLE IF NOT EXISTS tenant_connections (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  provider                TEXT NOT NULL,
  scope_kind              TEXT NOT NULL DEFAULT 'tenant',
  user_id                 TEXT,
  auth_kind               TEXT NOT NULL,
  external_account_id     TEXT,
  external_account_label  TEXT,
  environment             TEXT,
  granted_scopes_json     TEXT NOT NULL DEFAULT '[]',
  scope_set_version       INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'pending',
  token_version           INTEGER NOT NULL DEFAULT 0,
  refresh_lease_until     TEXT,
  last_health_at          TEXT,
  last_health_verdict     TEXT NOT NULL DEFAULT 'unknown',
  last_health_code        TEXT,
  last_health_detail      TEXT,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  connected_by            TEXT,
  connected_at            TEXT,
  revoked_at              TEXT,
  revoked_by              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

-- UNIQUE(tenant_id, provider, external_account_id, user_id), written with
-- COALESCE because SQLite treats NULLs as DISTINCT in a unique index: a plain
-- column index would let one tenant hold any number of rows for the same
-- provider whenever user_id (tenant-scoped connections) is NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_connections_account
  ON tenant_connections (tenant_id, provider, COALESCE(external_account_id, ''), COALESCE(user_id, ''));

-- ONE live connection per provider per tenant (and per user for user-scoped
-- rows), so switching accounts is an explicit disconnect and never two books
-- feeding one workspace. claimConnection checks this with a read first; two
-- connects of DIFFERENT accounts racing both pass that read, and this index is
-- what refuses the second (claimConnection maps the violation to
-- provider_already_connected). A revoked row no longer counts.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_connections_one_live
  ON tenant_connections (tenant_id, provider, COALESCE(user_id, ''))
  WHERE revoked_at IS NULL;

-- The hub and the routes: a tenant's live connections, by provider.
CREATE INDEX IF NOT EXISTS idx_tenant_connections_tenant_provider
  ON tenant_connections (tenant_id, provider, revoked_at);

-- Exception 1 (see header). A revoked row no longer holds the account, so an
-- account a tenant disconnected can be connected again, there or elsewhere.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_connections_exclusive_account
  ON tenant_connections (provider, external_account_id)
  WHERE revoked_at IS NULL
    AND external_account_id IS NOT NULL
    AND provider IN ('stripe', 'quickbooks', 'xero', 'plaid', 'meta', 'twilio');

-- A row never changes tenant.
CREATE TRIGGER IF NOT EXISTS tenant_connections_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_connections
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_connections.tenant_id is immutable');
END;

-- A pinned account is never swapped in place: connecting a different account is
-- a new row, which goes through the exclusivity index like any other.
CREATE TRIGGER IF NOT EXISTS tenant_connections_account_pinned
BEFORE UPDATE OF external_account_id ON tenant_connections
WHEN OLD.external_account_id IS NOT NULL
 AND NEW.external_account_id IS NOT OLD.external_account_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_connections.external_account_id is pinned once set - connect the other account as a new connection');
END;

-- ── oauth_states ───────────────────────────────────────────────────────────
-- pkce_verifier_enc: the PKCE code verifier, encrypted with lib/field-encryption
-- (NULL for a provider without PKCE). Rows older than a day are deleted by
-- /api/cron/connection-health.
CREATE TABLE IF NOT EXISTS oauth_states (
  nonce              TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  scope_set          TEXT NOT NULL DEFAULT '',
  pkce_verifier_enc  TEXT,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  consumed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_tenant_created
  ON oauth_states (tenant_id, created_at);

-- ── connection_health_checks ───────────────────────────────────────────────
-- check_source: connect | manual | cron | refresh
-- verdict: healthy | degraded | down | unknown
-- error_code: lib/connections/rules.ts PROBE_ERROR_CODES, NULL when healthy.
CREATE TABLE IF NOT EXISTS connection_health_checks (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  provider       TEXT NOT NULL,
  check_source   TEXT NOT NULL,
  checked_at     TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  latency_ms     INTEGER,
  error_code     TEXT,
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS idx_connection_health_checks_tenant_connection
  ON connection_health_checks (tenant_id, connection_id, checked_at);

-- Append-only: a probe result is history, never edited after the fact.
-- (Rows past the 30-day retention are deleted, not rewritten.)
CREATE TRIGGER IF NOT EXISTS connection_health_checks_append_only
BEFORE UPDATE ON connection_health_checks
BEGIN
  SELECT RAISE(ABORT, 'connection_health_checks is append-only');
END;

-- ── provider_webhook_routes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_webhook_routes (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  external_key   TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
-- Exception 2 (see header).
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_webhook_routes_key
  ON provider_webhook_routes (provider, external_key);
CREATE INDEX IF NOT EXISTS idx_provider_webhook_routes_tenant_connection
  ON provider_webhook_routes (tenant_id, connection_id);
