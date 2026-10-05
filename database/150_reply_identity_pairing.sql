-- ============================================================================
-- 150 — the sending identity holds its shape AFTER provisioning, not only at it.
--
-- REFERENCE DIALECT. Production runs the libSQL twin
-- (database/turso/150_reply_identity_pairing.turso.sql); this file is the
-- Postgres statement of the same rules, same convention as 147-149.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 149. 149 is applied on the
-- production (Turso) database — schema_migrations records checksum 70a5a0e02762
-- at 2026-08-20T15:44:14Z — and the runner refuses a file whose checksum moved
-- after it was applied. Superseding is the only correct move, and the two
-- dialects stay in lockstep by both being superseded.
--
-- WHAT 149 LEFT OPEN (all four measured on a replica of 148+149, not reasoned
-- about — see the twin's header for the exact probe results):
--   1. The address and the mode were paired only in the application. The
--      database accepted shared_oasis beside a client-domain address,
--      per_client_subaddress with no +tag, and per_client_domain pointed back at
--      oasisai.work — on INSERT and on UPDATE.
--   2. A blank or note-shaped dns_verified_at satisfied the activation guard.
--   3. Two clients could hold the identical per-client sending address, which
--      silently voids the per-client analytics the mode is sold on.
--   4. 149's insert-trigger abort message contains a semicolon, which shatters
--      under any applier that splits on ';' without tracking string literals.
--
-- HOW THE TWO DIALECTS EXPRESS THE SAME RULES
--   * The pairing is a CHECK constraint here and a pair of BEFORE INSERT /
--     BEFORE UPDATE triggers in libSQL, because SQLite has no ALTER TABLE ADD
--     CONSTRAINT (see 149's twin header). A CHECK already fires on both
--     operations, so one constraint covers what needs two triggers there.
--   * dns_verified_at needs NO shape guard here: the column is timestamptz, so
--     the empty string and the words "not verified yet" cannot be stored at all.
--     The libSQL twin carries a GLOB trigger because its column is TEXT — the
--     dialect difference is real, and the guard exists exactly where the weaker
--     type is. lib/reply-identity.ts isRecordedTimestamp() is the app-side gate
--     for both.
--   * The mode-required trigger function is replaced rather than dropped, for
--     the semicolon and for one structural reason given at its definition.
--
-- SAFE ON THIS TABLE: production holds 0 rows. Every rule below is scoped to
-- rows that HAVE a mode, so a pre-149 row (mode NULL, nobody chose) is untouched
-- and keeps taking the inbound webhook's ingest_key_last_used_at stamp. It still
-- cannot be activated, which remains the point.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The address must match the mode it is filed under
-- ---------------------------------------------------------------------------
-- Mirrors resolveReplyIdentity() in lib/reply-identity.ts, which stays the
-- primary gate and the one that explains itself. This is the backstop for the
-- writer that never went through the app: a hand-run UPDATE, a future
-- profile-edit surface, an import.
--
-- The client-domain test is right(addr, length(domain) + 1) rather than
-- `addr like '%@' || website_domain`: LIKE would read an underscore in a stored
-- domain as a wildcard, and an unanchored suffix test is how evil-oasisai.work
-- passes as OASIS-owned. The regexes are anchored at both ends for the same
-- reason.
alter table public.client_automation_profiles
  drop constraint if exists client_automation_profiles_identity_pairing;
alter table public.client_automation_profiles
  add constraint client_automation_profiles_identity_pairing
  check (
    reply_identity_mode is null
    or (
      -- One bare mailbox. The display-name form (Acme <hello@acme.com>) has
      -- already cost this codebase a malformed Message-Id on every send.
      length(lower(btrim(reply_from_identity)))
        - length(replace(lower(btrim(reply_from_identity)), '@', '')) = 1
      and case reply_identity_mode
        -- One shared OASIS mailbox, no tag: a tagged address is the other mode,
        -- and filing it here reports shared reputation for a client that
        -- actually has its own analytics lane.
        when 'shared_oasis' then
          lower(btrim(reply_from_identity)) ~ '^[^@+]+@([a-z0-9-]+\.)*oasisai\.work$'
        -- Same domain, but the +tag is the entire mechanism of the mode.
        when 'per_client_subaddress' then
          lower(btrim(reply_from_identity)) ~ '^[^@+]+\+[^@]+@([a-z0-9-]+\.)*oasisai\.work$'
        -- The CLIENT's own domain, and nothing else. An oasisai.work address
        -- gets none of the isolation this mode is chosen for, and a third
        -- party's domain fails SPF alignment while borrowing a reputation
        -- nobody granted.
        when 'per_client_domain' then
          lower(btrim(reply_from_identity)) !~ '@([a-z0-9-]+\.)*oasisai\.work$'
          and length(lower(btrim(reply_from_identity))) > length(lower(btrim(website_domain))) + 1
          and right(lower(btrim(reply_from_identity)), length(lower(btrim(website_domain))) + 1)
              in ('@' || lower(btrim(website_domain)), '.' || lower(btrim(website_domain)))
        -- Unreachable while the 149 vocabulary CHECK holds. False rather than
        -- true so that a fourth mode added to the enum and forgotten here fails
        -- closed instead of shipping unvalidated.
        else false
      end
    )
  );

-- Documented on the column an operator actually inspects. One literal rather
-- than the adjacent-string concatenation 149 used: that form is valid Postgres
-- but defeats every SQL parser reviewing this file, and there is nothing to be
-- gained by being clever in a comment.
comment on column public.client_automation_profiles.reply_from_identity is
  'The bare sending mailbox, and it must be legal for reply_identity_mode: shared_oasis and per_client_subaddress on an OASIS-owned domain (the second with a +tag, the first without), per_client_domain on the profile own website_domain and never on oasisai.work. Enforced on insert AND update by client_automation_profiles_identity_pairing, because the pairing was previously checked once at provisioning and nothing re-checked it afterwards.';

-- ---------------------------------------------------------------------------
-- 2. One per-client sending identity belongs to one client
-- ---------------------------------------------------------------------------
-- Global, not per tenant, for the same reason ingest_key_hash is: the address is
-- what a reply arrives as and what a bounce comes back to, so it must resolve to
-- exactly one profile.
--
-- Partial, covering only the two per-client modes: shared_oasis is DEFINED as
-- every client sending from the same mailbox, so a blanket unique index would
-- make the cheapest mode unusable for the second client who chose it.
create unique index if not exists client_automation_profiles_per_client_identity_idx
  on public.client_automation_profiles (lower(btrim(reply_from_identity)))
  where reply_identity_mode in ('per_client_subaddress', 'per_client_domain');

-- ---------------------------------------------------------------------------
-- 3. 149's mode-required trigger, replaced
-- ---------------------------------------------------------------------------
-- Two changes, no behaviour change:
--
--   * The abort text no longer contains a semicolon. The libSQL twin of that
--     message shatters a naive ';' splitter mid-string-literal, and keeping the
--     two dialects' messages identical is what makes them a port rather than two
--     schemas.
--   * OLD is referenced only inside the tg_op = 'UPDATE' branch. 149 relied on
--     `tg_op = 'UPDATE' and ... and old.reply_identity_mode is not null` in one
--     expression, which is correct only if AND short-circuits — and PostgreSQL
--     does not guarantee evaluation order. Nesting removes the question rather
--     than betting on it. Untestable here (no PostgreSQL on this machine), which
--     is itself the reason to prefer the shape that needs no test.
create or replace function public.client_automation_profiles_require_identity_mode()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.reply_identity_mode is null then
      raise exception
        'reply_identity_mode is required - choose shared_oasis, per_client_subaddress or per_client_domain explicitly. There is no default sender identity';
    end if;
  elsif tg_op = 'UPDATE' then
    -- A mode that was set may never be un-set, and no profile may cross INTO
    -- 'active' without one. Scoped this narrowly on purpose: a blanket
    -- "new.reply_identity_mode is null" would freeze a pre-149 row out of every
    -- routine write, including the ingest_key_last_used_at stamp the inbound
    -- webhook makes on every post — presenting as that client's automation
    -- dying, a worse failure than the undeclared mode it was correcting.
    if new.reply_identity_mode is null
       and (old.reply_identity_mode is not null
            or (new.status = 'active' and old.status <> 'active')) then
      raise exception
        'reply_identity_mode cannot be cleared, and a profile cannot be activated without one';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

commit;
