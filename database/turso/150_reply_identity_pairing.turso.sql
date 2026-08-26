-- 150 — the sending identity holds its shape AFTER provisioning, not only at it.
--
-- THIS IS THE FILE THAT ACTUALLY RUNS. Production is
-- EMPIRE_DATA_BACKEND=turso_cloud. The Postgres companion (database/150) is the
-- reference dialect. Same warning 147, 148 and 149 carry.
--
-- WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO 149. 149 is applied: the
-- schema_migrations ledger on the production database records
-- 149_reply_identity_mode.turso.sql, checksum 70a5a0e02762, applied
-- 2026-08-20T15:44:14Z, 7 statements. The runner compares that checksum against
-- the file on every run and refuses a file that changed after being applied, so
-- editing 149 in place would turn every future migration run into a hard stop.
-- Superseding is the only correct move.
--
-- ---------------------------------------------------------------------------
-- WHAT 149 LEFT OPEN — all four measured against a replica of 148+149, not
-- reasoned about
-- ---------------------------------------------------------------------------
--   1. THE ADDRESS AND THE MODE WERE ONLY EVER PAIRED IN THE APPLICATION.
--      buildClientProfileDraft() checks them; the database never did. Verified
--      accepted on a 148+149 replica: reply_identity_mode='shared_oasis' beside
--      reply_from_identity='hello@acmehvac.com' (OASIS sending as a domain it
--      does not control), per_client_subaddress with no +tag at all, and
--      per_client_domain pointed back at oasisai.work. Also verified: an UPDATE
--      could rewrite a live profile address to anything, because nothing
--      re-checks the pairing after the insert. Requirements 1 and 3 got two
--      layers; requirement 4 had one, and it was the layer a hand-run SQL
--      statement or the first profile-edit surface bypasses.
--   2. A BLANK ATTESTATION SATISFIED THE DNS GUARD. 149's CHECK asks only
--      dns_verified_at IS NOT NULL. Verified accepted: an ACTIVE
--      per_client_domain row with dns_verified_at='' and another with
--      'not verified yet'. The column is TEXT here (timestamptz in the Postgres
--      twin), so a note fits in it, and a note that reads as verification is
--      worse than an empty column because the guard still looks enforced.
--   3. TWO CLIENTS COULD BE GIVEN THE IDENTICAL SUBADDRESS. Verified accepted.
--      per_client_subaddress is sold as per-client threading, filtering and
--      bounce analytics. Sharing one tag between two clients silently delivers
--      none of that, and nothing in the product would ever say so.
--   4. THE ABORT MESSAGE IN 149's INSERT TRIGGER CONTAINS A SEMICOLON. The house
--      runner survives it (it tracks BEGIN/END depth), but a naive split of 149
--      on ';' yields 10 fragments instead of 7 and dies on
--      "unrecognized token: 'reply_identity_mode is required". A Turso web
--      console paste or a sqlite3 wrapper is a plausible path, and
--      apply_turso_migration.py does not stop at the first failure — it commits
--      what succeeded before raising, and 149's ADD COLUMNs are not re-runnable.
--      Recreated below with no semicolon in the text. Nothing else about that
--      trigger changes.
--
-- A CORRECTION TO 149's HEADER while it is being superseded: 149 states that
-- "ALTER TABLE ... ADD COLUMN x TEXT NOT NULL with no DEFAULT is a hard error".
-- Measured: it is ACCEPTED on an empty table and rejected only once rows exist
-- ("Cannot add a NOT NULL column with default value NULL"), which is the same
-- data-dependence 149's point 2 describes. The conclusion 149 drew was right —
-- a migration should not behave differently based on data it cannot see — but
-- the stated rule was over-broad, and this table was in fact empty.
--
-- SAFE ON THIS TABLE TODAY: production holds 0 rows (verified by count). The
-- pairing triggers below therefore cannot fail an existing profile. They are
-- scoped to rows that HAVE a mode, so a pre-149 row (mode NULL, nobody chose)
-- keeps taking the inbound webhook's ingest_key_last_used_at stamp exactly as
-- 149 intended — it still cannot be activated, which remains the point.
--
-- The application layer (lib/reply-identity.ts, lib/client-automation-profiles.ts)
-- stays the primary gate and names the fix in plain words. Everything here is
-- the backstop, and it is deliberately blunter: it names the rule, not the
-- remedy.
--
-- No explicit BEGIN/COMMIT: the runner executes a file as one transactional
-- batch, and a nested BEGIN errors out.

-- ---------------------------------------------------------------------------
-- 1. 149's insert trigger, recreated with no semicolon in the abort text
-- ---------------------------------------------------------------------------
-- Same rule, same name, same behaviour. Only the message changed.
DROP TRIGGER IF EXISTS "client_automation_profiles_mode_required_on_insert";
CREATE TRIGGER "client_automation_profiles_mode_required_on_insert"
BEFORE INSERT ON "client_automation_profiles"
WHEN NEW."reply_identity_mode" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'reply_identity_mode is required - choose shared_oasis, per_client_subaddress or per_client_domain explicitly. There is no default sender identity');
END;

-- ---------------------------------------------------------------------------
-- 2. The address must match the mode it is filed under — on INSERT and UPDATE
-- ---------------------------------------------------------------------------
-- Written as SELECT RAISE(...) WHERE <rule is broken> rather than CASE/END: the
-- house runner's splitter closes a statement at a line matching END followed by
-- a semicolon, so a CASE ... END inside a trigger body would be cut in half and
-- applied as two invalid fragments. This shape has exactly one END, the trigger
-- terminator.
--
-- Every predicate re-derives lower(trim(reply_from_identity)) instead of
-- trusting the app to have normalized it, because the writer this guard exists
-- for is precisely the one that did not go through the app.
--
-- The tail comparison is substr(addr, length(addr) - length(domain)) rather than
-- LIKE '%@' || domain: LIKE would treat an underscore in a stored domain as a
-- wildcard, and a suffix test that is not anchored on the dot is how
-- evil-oasisai.work passes as OASIS-owned.
DROP TRIGGER IF EXISTS "client_automation_profiles_identity_pairing_on_insert";
CREATE TRIGGER "client_automation_profiles_identity_pairing_on_insert"
BEFORE INSERT ON "client_automation_profiles"
WHEN NEW."reply_identity_mode" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reply_from_identity must be one bare mailbox such as support@oasisai.work - no display name, no second address')
    WHERE length(lower(trim(NEW."reply_from_identity"))) - length(replace(lower(trim(NEW."reply_from_identity")), '@', '')) <> 1;

  SELECT RAISE(ABORT, 'shared_oasis and per_client_subaddress must send from an address on oasisai.work - OASIS cannot send as a domain it does not control')
    WHERE NEW."reply_identity_mode" IN ('shared_oasis', 'per_client_subaddress')
      AND NOT (length(lower(trim(NEW."reply_from_identity"))) > 13
               AND substr(lower(trim(NEW."reply_from_identity")), length(lower(trim(NEW."reply_from_identity"))) - 12) IN ('@oasisai.work', '.oasisai.work'));

  SELECT RAISE(ABORT, 'shared_oasis must not carry a plus tag - a tagged address is per_client_subaddress, and filing it as shared reports one shared reputation for a client that has its own analytics lane')
    WHERE NEW."reply_identity_mode" = 'shared_oasis'
      AND substr(lower(trim(NEW."reply_from_identity")), 1, instr(lower(trim(NEW."reply_from_identity")), '@') - 1) LIKE '%+%';

  SELECT RAISE(ABORT, 'per_client_subaddress needs a non-empty plus tag identifying the client, such as support+acmehvac@oasisai.work - without one every client lands in the same undifferentiated stream')
    WHERE NEW."reply_identity_mode" = 'per_client_subaddress'
      AND substr(lower(trim(NEW."reply_from_identity")), 1, instr(lower(trim(NEW."reply_from_identity")), '@') - 1) NOT LIKE '%+_%';

  SELECT RAISE(ABORT, 'per_client_domain must send from the client own domain, not from oasisai.work - an OASIS address gets none of the reputation isolation this mode is chosen for')
    WHERE NEW."reply_identity_mode" = 'per_client_domain'
      AND length(lower(trim(NEW."reply_from_identity"))) > 13
      AND substr(lower(trim(NEW."reply_from_identity")), length(lower(trim(NEW."reply_from_identity"))) - 12) IN ('@oasisai.work', '.oasisai.work');

  SELECT RAISE(ABORT, 'per_client_domain must send from this profile own website_domain - sending as a third party domain fails SPF alignment and borrows a reputation nobody granted')
    WHERE NEW."reply_identity_mode" = 'per_client_domain'
      AND NOT (length(lower(trim(NEW."reply_from_identity"))) > length(lower(trim(NEW."website_domain"))) + 1
               AND substr(lower(trim(NEW."reply_from_identity")), length(lower(trim(NEW."reply_from_identity"))) - length(lower(trim(NEW."website_domain")))) IN ('@' || lower(trim(NEW."website_domain")), '.' || lower(trim(NEW."website_domain"))));
END;

-- The same rules on UPDATE. This is the half 149 never had: the pairing was
-- checked once, at insert, and an UPDATE could walk a live profile off it.
DROP TRIGGER IF EXISTS "client_automation_profiles_identity_pairing_on_update";
CREATE TRIGGER "client_automation_profiles_identity_pairing_on_update"
BEFORE UPDATE ON "client_automation_profiles"
WHEN NEW."reply_identity_mode" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reply_from_identity must be one bare mailbox such as support@oasisai.work - no display name, no second address')
    WHERE length(lower(trim(NEW."reply_from_identity"))) - length(replace(lower(trim(NEW."reply_from_identity")), '@', '')) <> 1;

  SELECT RAISE(ABORT, 'shared_oasis and per_client_subaddress must send from an address on oasisai.work - OASIS cannot send as a domain it does not control')
    WHERE NEW."reply_identity_mode" IN ('shared_oasis', 'per_client_subaddress')
      AND NOT (length(lower(trim(NEW."reply_from_identity"))) > 13
               AND substr(lower(trim(NEW."reply_from_identity")), length(lower(trim(NEW."reply_from_identity"))) - 12) IN ('@oasisai.work', '.oasisai.work'));

  SELECT RAISE(ABORT, 'shared_oasis must not carry a plus tag - a tagged address is per_client_subaddress, and filing it as shared reports one shared reputation for a client that has its own analytics lane')
    WHERE NEW."reply_identity_mode" = 'shared_oasis'
      AND substr(lower(trim(NEW."reply_from_identity")), 1, instr(lower(trim(NEW."reply_from_identity")), '@') - 1) LIKE '%+%';

  SELECT RAISE(ABORT, 'per_client_subaddress needs a non-empty plus tag identifying the client, such as support+acmehvac@oasisai.work - without one every client lands in the same undifferentiated stream')
    WHERE NEW."reply_identity_mode" = 'per_client_subaddress'
      AND substr(lower(trim(NEW."reply_from_identity")), 1, instr(lower(trim(NEW."reply_from_identity")), '@') - 1) NOT LIKE '%+_%';

  SELECT RAISE(ABORT, 'per_client_domain must send from the client own domain, not from oasisai.work - an OASIS address gets none of the reputation isolation this mode is chosen for')
    WHERE NEW."reply_identity_mode" = 'per_client_domain'
      AND length(lower(trim(NEW."reply_from_identity"))) > 13
      AND substr(lower(trim(NEW."reply_from_identity")), length(lower(trim(NEW."reply_from_identity"))) - 12) IN ('@oasisai.work', '.oasisai.work');

  SELECT RAISE(ABORT, 'per_client_domain must send from this profile own website_domain - sending as a third party domain fails SPF alignment and borrows a reputation nobody granted')
    WHERE NEW."reply_identity_mode" = 'per_client_domain'
      AND NOT (length(lower(trim(NEW."reply_from_identity"))) > length(lower(trim(NEW."website_domain"))) + 1
               AND substr(lower(trim(NEW."reply_from_identity")), length(lower(trim(NEW."reply_from_identity"))) - length(lower(trim(NEW."website_domain")))) IN ('@' || lower(trim(NEW."website_domain")), '.' || lower(trim(NEW."website_domain"))));
END;

-- ---------------------------------------------------------------------------
-- 3. dns_verified_at must be a MOMENT, not a note
-- ---------------------------------------------------------------------------
-- 149 asks only IS NOT NULL, so the empty string and the words not verified yet
-- both unlocked an active per_client_domain profile. This is the single key to
-- the single guard that keeps unauthenticated mail off a client domain, so it
-- must not be forgeable by typing a word into the column.
--
-- GLOB, not LIKE: GLOB is case-sensitive and has character classes, so the T
-- separator and the four-digit year are actually checked. The shape matches
-- isRecordedTimestamp() in lib/reply-identity.ts, which is the app-side gate --
-- the two layers agreeing on one shape is what keeps the app from accepting
-- something the column then rejects.
--
-- Unscoped by mode on purpose: a stray note in this column is wrong on any
-- profile, and reading it back later as evidence of a DNS check is the harm.
DROP TRIGGER IF EXISTS "client_automation_profiles_dns_shape_on_insert";
CREATE TRIGGER "client_automation_profiles_dns_shape_on_insert"
BEFORE INSERT ON "client_automation_profiles"
WHEN NEW."dns_verified_at" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dns_verified_at must be an ISO-8601 instant such as 2026-08-20T12:00:00.000Z - a note is not a verification and must never unlock sending from a client domain')
    WHERE NEW."dns_verified_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*';
END;

DROP TRIGGER IF EXISTS "client_automation_profiles_dns_shape_on_update";
CREATE TRIGGER "client_automation_profiles_dns_shape_on_update"
BEFORE UPDATE ON "client_automation_profiles"
WHEN NEW."dns_verified_at" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dns_verified_at must be an ISO-8601 instant such as 2026-08-20T12:00:00.000Z - a note is not a verification and must never unlock sending from a client domain')
    WHERE NEW."dns_verified_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*';
END;

-- ---------------------------------------------------------------------------
-- 4. One per-client sending identity belongs to one client
-- ---------------------------------------------------------------------------
-- Global, not per tenant, for the same reason ingest_key_hash is: the address is
-- what a reply arrives as and what a bounce comes back to, so it has to resolve
-- to exactly one profile across the whole database.
--
-- Partial, covering only the two per-client modes. shared_oasis is DEFINED as
-- every client sending from the same mailbox, so a blanket unique index would
-- make the cheapest mode unusable for the second client who chose it.
--
-- Indexed on lower(trim(...)) so two rows differing only in case or padding
-- still collide -- the app normalizes, and this guards the writer that did not.
CREATE UNIQUE INDEX IF NOT EXISTS "client_automation_profiles_per_client_identity_idx"
  ON "client_automation_profiles" (lower(trim("reply_from_identity")))
  WHERE "reply_identity_mode" IN ('per_client_subaddress', 'per_client_domain');
