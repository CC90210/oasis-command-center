-- 149 — reply_identity_mode: make the sending identity a decision, not a string.
--
-- THIS IS THE FILE THAT ACTUALLY RUNS. Production is
-- EMPIRE_DATA_BACKEND=turso_cloud; the Postgres companion (database/149) is the
-- reference dialect. Same warning 147 and 148 carry.
--
-- WHAT WAS WRONG. 148 shipped reply_from_identity as free text: NOT NULL, plus
-- a "not blank" CHECK. Any string satisfied it. But the three addresses that
-- would all pass have three different blast radii, and the difference is a
-- client's mail either arriving or not:
--
--   support@oasisai.work            every client shares ONE sender reputation.
--                                   One client's spam complaints degrade
--                                   deliverability for every other client, and
--                                   nothing in the product would say why.
--   support+acmehvac@oasisai.work   same domain reputation, but per-client
--                                   threading, filtering and bounce analytics —
--                                   isolated enough to diagnose, not to contain.
--   hello@acmehvac.com              full isolation, best recipient trust, and
--                                   REQUIRES SPF/DKIM/DMARC on the client's own
--                                   DNS before a single message ships.
--
-- The column recorded which of those was chosen only by accident of what someone
-- typed. This migration makes the choice a stored, constrained decision, and
-- makes the third one impossible to switch on before its DNS exists.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS AN ALTER, AND WHY THE NEW COLUMN IS NOT LITERALLY "NOT NULL"
-- ---------------------------------------------------------------------------
-- client_automation_profiles already exists in production, so this is ALTER, not
-- CREATE. SQLite/libSQL then removes two options that Postgres would give us,
-- both verified against an in-memory libSQL rather than assumed:
--
--   1. `ALTER TABLE ... ADD COLUMN x TEXT NOT NULL` with no DEFAULT is a hard
--      error: "Cannot add a NOT NULL column with default value NULL". The only
--      way to satisfy it is a DEFAULT — which is precisely the silent decision
--      about somebody else's sender reputation this migration exists to abolish.
--   2. `ADD COLUMN x TEXT CHECK (x IS NOT NULL AND x IN (...))` is accepted on an
--      EMPTY table and REJECTED AT DDL TIME on a populated one, because SQLite
--      validates a new CHECK against existing rows and the backfilled NULL fails
--      it. That form is a migration that works or does not depending on data it
--      cannot see.
--   3. `ALTER TABLE ... ADD CONSTRAINT` does not exist in SQLite at all
--      (syntax error), so a constraint cannot be bolted on afterwards without
--      rebuilding the whole table.
--
-- So: a nullable column whose CHECK tolerates NULL, and TRIGGERS that make NULL
-- unwritable going forward. Triggers are the right tool precisely because they
-- are NOT validated against existing rows — this migration behaves identically
-- whether the table currently holds zero rows or a thousand, which is a property
-- a migration should have rather than a fact about today's data.
--
-- AND THERE IS DELIBERATELY NO BACKFILL. Backfilling any of the three ids onto a
-- pre-existing row would be inventing the decision this migration exists to
-- force. NULL is the honest record that nobody chose. Such a row keeps working
-- (the webhook can still stamp ingest_key_last_used_at) but cannot be ACTIVATED
-- until an operator picks a mode. To find them:
--   SELECT "id","client_name","status" FROM "client_automation_profiles"
--    WHERE "reply_identity_mode" IS NULL;
--
-- The application layer (lib/reply-identity.ts, lib/client-automation-profiles.ts)
-- is the primary gate and refuses a missing or mismatched mode with an error
-- that names the fix. Everything below is the backstop.

-- The chosen mode. NULL only ever means "written before 149 existed"; nothing
-- may write it, and lib/reply-identity.ts REPLY_IDENTITY_MODES is the matching
-- vocabulary (tests/reply-identity.test.ts asserts the two agree).
ALTER TABLE "client_automation_profiles" ADD COLUMN "reply_identity_mode" TEXT
  CONSTRAINT "client_automation_profiles_reply_identity_mode_known"
  CHECK ("reply_identity_mode" IS NULL
         OR "reply_identity_mode" IN ('shared_oasis','per_client_subaddress','per_client_domain'));

-- When SPF/DKIM/DMARC were confirmed on the CLIENT's domain. NULL means never,
-- and for per_client_domain that is a hard block on going live: until those
-- records exist, every message is unauthenticated mail claiming to be the
-- client, and it is the client's domain — not OASIS's — that gets scored down
-- for it. Meaningless for the two OASIS-owned modes, which is why the guard
-- below is scoped to the one mode rather than to the column.
--
-- The cross-column CHECK rides along with ADD COLUMN because SQLite cannot add a
-- table constraint afterwards (see 3 above); the columns it names must already
-- exist, which is why this statement is second. It enforces on INSERT and on
-- UPDATE, and it is safe against pre-existing rows: a NULL mode makes the
-- expression NULL, and SQLite treats a NULL CHECK as satisfied.
ALTER TABLE "client_automation_profiles" ADD COLUMN "dns_verified_at" TEXT
  CONSTRAINT "client_automation_profiles_active_needs_dns"
  CHECK ("status" <> 'active'
         OR "reply_identity_mode" <> 'per_client_domain'
         OR "dns_verified_at" IS NOT NULL);

-- No new profile without an explicit decision. This is the "NOT NULL" that
-- ALTER TABLE could not express, and unlike a DEFAULT it cannot quietly answer
-- the question on the operator's behalf.
DROP TRIGGER IF EXISTS "client_automation_profiles_mode_required_on_insert";
CREATE TRIGGER "client_automation_profiles_mode_required_on_insert"
BEFORE INSERT ON "client_automation_profiles"
WHEN NEW."reply_identity_mode" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'reply_identity_mode is required - choose shared_oasis, per_client_subaddress or per_client_domain explicitly; there is no default sender identity');
END;

-- A mode that was set may never be un-set, and no profile may cross INTO
-- 'active' without one.
--
-- Scoped this narrowly on purpose. A blanket "NEW.reply_identity_mode IS NULL"
-- would freeze a pre-149 row out of every routine write, including the
-- ingest_key_last_used_at stamp the inbound webhook makes on every post — which
-- would present as that client's automation dying, a worse failure than the
-- undeclared mode it was trying to correct.
DROP TRIGGER IF EXISTS "client_automation_profiles_mode_required_on_update";
CREATE TRIGGER "client_automation_profiles_mode_required_on_update"
BEFORE UPDATE ON "client_automation_profiles"
WHEN NEW."reply_identity_mode" IS NULL
     AND (OLD."reply_identity_mode" IS NOT NULL
          OR (NEW."status" = 'active' AND OLD."status" <> 'active'))
BEGIN
  SELECT RAISE(ABORT, 'reply_identity_mode cannot be cleared, and a profile cannot be activated without one');
END;

-- Operator sweep: which live clients are on which mode, and which per_client_domain
-- profiles are still waiting on DNS. Partial, because the answer is only ever
-- wanted for profiles that have made the decision.
CREATE INDEX IF NOT EXISTS "client_automation_profiles_identity_mode_idx"
  ON "client_automation_profiles" ("reply_identity_mode", "status")
  WHERE "reply_identity_mode" IS NOT NULL;
