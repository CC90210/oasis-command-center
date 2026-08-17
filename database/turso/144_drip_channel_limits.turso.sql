-- 144 — the per-channel send ceilings get their own row.
--
-- WHY A TABLE INSTEAD OF THE JSON BLOB IT STARTED IN. These four integers were
-- first stored on tenants.custom_fields.drip_limits, to avoid a migration. That
-- column is shared with other product features, which made every write a
-- read-modify-write over data owned by other features, and three successive attempts to
-- make that safe each introduced a subtler bug:
--
--   1. plain read-modify-write        silently discarded a concurrent change
--   2. write then read back           detected a race that had already happened
--                                     but did not prevent the next one
--   3. compare-and-swap on the blob   the adapter PARSES json on read, so the
--                                     token was a re-serialised object rather
--                                     than the stored text; any row whose JSON
--                                     formatting differed at all would never match and
--                                     every save would fail after three retries
--
-- The problem was never the locking, it was sharing a cell. A row nobody else
-- writes needs no compare-and-swap: an upsert is atomic on a single primary key.
--
-- Ceilings are NOT enforced here. Validation lives in channel-limits-core.ts
-- with the tests, and a CHECK constraint duplicating it would be a second place
-- to change and a chance for the two to disagree. The column is a plain
-- non-negative integer; zero is legal and means stopped.

CREATE TABLE IF NOT EXISTS "drip_channel_limits" (
  "tenant_id"             TEXT NOT NULL PRIMARY KEY,
  "sms_daily"             INTEGER,
  "sms_hourly"            INTEGER,
  "email_daily_sunbiz"    INTEGER,
  "email_daily_bluerise"  INTEGER,
  "updated_at"            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
);

-- NULL means "not set here", which falls through to env and then to the
-- built-in default. That is deliberately distinct from 0, which means stopped.
