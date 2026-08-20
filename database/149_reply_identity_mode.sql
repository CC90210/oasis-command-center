-- ============================================================================
-- 149 — reply_identity_mode: make the sending identity a decision, not a string.
--
-- REFERENCE DIALECT. Production runs the libSQL twin
-- (database/turso/149_reply_identity_mode.turso.sql); this file is the Postgres
-- statement of the same schema, same convention as 147 and 148.
--
-- WHAT WAS WRONG
-- 148 shipped reply_from_identity as free text: NOT NULL plus a "not blank"
-- CHECK. Any string satisfied it. But the three addresses that would all pass
-- have three different blast radii:
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
-- typed. This makes the choice stored and constrained, and makes the third one
-- impossible to switch on before its DNS exists.
--
-- WHY THE COLUMN IS NULLABLE HERE TOO
-- Postgres could add `not null` outright on an empty table — and would fail on a
-- populated one, so the migration's behaviour would depend on data it cannot
-- see. It is also the wrong shape for a different reason: the only way to make
-- `not null` survive existing rows is a DEFAULT or a backfill, and both of those
-- ARE the silent decision about somebody else's sender reputation that this
-- migration exists to abolish. NULL is the honest record that nobody chose.
--
-- So both dialects carry the SAME SEMANTICS by different syntax: a nullable
-- column, a CHECK that tolerates NULL, and triggers that make NULL unwritable
-- going forward. (libSQL has no ALTER TABLE ADD CONSTRAINT and cannot add a
-- NOT NULL column without a default at all — see the twin's header for the
-- verified specifics.) Keeping the semantics identical is what makes the two
-- files a port rather than two schemas.
--
-- NO BACKFILL, DELIBERATELY. A pre-149 row keeps working — the webhook can still
-- stamp ingest_key_last_used_at — but cannot be ACTIVATED until an operator
-- picks a mode. To find them:
--   select id, client_name, status from public.client_automation_profiles
--    where reply_identity_mode is null;
--
-- The application layer (lib/reply-identity.ts, lib/client-automation-profiles.ts)
-- is the primary gate and refuses a missing or mismatched mode with an error that
-- names the fix. Everything below is the backstop.
-- ============================================================================

begin;

-- The chosen mode. NULL only ever means "written before 149 existed"; nothing
-- may write it. lib/reply-identity.ts REPLY_IDENTITY_MODES is the matching
-- vocabulary (tests/reply-identity.test.ts asserts the two agree).
alter table public.client_automation_profiles
  add column if not exists reply_identity_mode text;

alter table public.client_automation_profiles
  drop constraint if exists client_automation_profiles_reply_identity_mode_known;
alter table public.client_automation_profiles
  add constraint client_automation_profiles_reply_identity_mode_known
  check (reply_identity_mode is null
         or reply_identity_mode in ('shared_oasis','per_client_subaddress','per_client_domain'));

comment on column public.client_automation_profiles.reply_identity_mode is
  'Which sending identity strategy this client is on: shared_oasis (one shared '
  'OASIS mailbox, ONE shared sender reputation), per_client_subaddress '
  '(support+client@oasisai.work — shared domain reputation, per-client analytics), '
  'or per_client_domain (the client''s own verified domain, full isolation, needs '
  'SPF/DKIM/DMARC first). NEVER defaulted: the choice decides whose reputation '
  'absorbs this client''s spam complaints, and it is an operator decision made at '
  'provisioning, not a question the business owner is asked.';

-- When SPF/DKIM/DMARC were confirmed on the CLIENT's domain. NULL means never,
-- and for per_client_domain that is a hard block on going live: until those
-- records exist, every message is unauthenticated mail claiming to be the
-- client, and it is the client's domain — not OASIS's — that gets scored down.
-- Meaningless for the two OASIS-owned modes, which is why the guard below is
-- scoped to the one mode rather than to the column.
alter table public.client_automation_profiles
  add column if not exists dns_verified_at timestamptz;

comment on column public.client_automation_profiles.dns_verified_at is
  'When SPF/DKIM/DMARC were verified on the CLIENT''s own domain. Only meaningful '
  'for reply_identity_mode = per_client_domain, where NULL blocks activation: '
  'sending from an unverified client domain is how a domain gets blacklisted, and '
  'the client is the one who pays for it.';

-- Safe against pre-existing rows: a NULL mode makes the expression NULL, and a
-- CHECK is satisfied by NULL. Enforced on insert and on update.
alter table public.client_automation_profiles
  drop constraint if exists client_automation_profiles_active_needs_dns;
alter table public.client_automation_profiles
  add constraint client_automation_profiles_active_needs_dns
  check (status <> 'active'
         or reply_identity_mode <> 'per_client_domain'
         or dns_verified_at is not null);

-- No new profile without an explicit decision, and no clearing or activating
-- around it afterwards. This is the "not null" a DEFAULT would have faked.
--
-- The update arm is scoped narrowly on purpose. A blanket "new.reply_identity_mode
-- is null" would freeze a pre-149 row out of every routine write, including the
-- ingest_key_last_used_at stamp the inbound webhook makes on every post — which
-- would present as that client's automation dying, a worse failure than the
-- undeclared mode it was trying to correct.
create or replace function public.client_automation_profiles_require_identity_mode()
returns trigger as $$
begin
  if tg_op = 'INSERT' and new.reply_identity_mode is null then
    raise exception
      'reply_identity_mode is required - choose shared_oasis, per_client_subaddress or per_client_domain explicitly; there is no default sender identity';
  end if;
  if tg_op = 'UPDATE' and new.reply_identity_mode is null
     and (old.reply_identity_mode is not null
          or (new.status = 'active' and old.status <> 'active')) then
    raise exception
      'reply_identity_mode cannot be cleared, and a profile cannot be activated without one';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_client_automation_profiles_require_identity_mode
  on public.client_automation_profiles;
create trigger trg_client_automation_profiles_require_identity_mode
  before insert or update on public.client_automation_profiles
  for each row execute function public.client_automation_profiles_require_identity_mode();

-- Operator sweep: which live clients are on which mode, and which
-- per_client_domain profiles are still waiting on DNS. Partial, because the
-- answer is only ever wanted for profiles that have made the decision.
create index if not exists client_automation_profiles_identity_mode_idx
  on public.client_automation_profiles (reply_identity_mode, status)
  where reply_identity_mode is not null;

commit;
