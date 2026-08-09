-- 136_email_suppressions_tenant_not_null.sql
--
-- Make it impossible to file an opt-out that is never enforced.
--
-- checkEmailSuppressed() (lib/lead-interactions-queries.ts) filters on
-- tenant_id, so a row with tenant_id IS NULL can never match: the person
-- unsubscribed and keeps receiving mail, silently. The 2026-08-05 audit found
-- exactly one such row in production, a standing "never email" order that had
-- not been in force since it was written.
--
-- Root cause: the /api/unsubscribe WRITE path resolves DRIP_SUPPRESSION_BRAND to
-- a tenant by name (tenants.name ILIKE <brand>). A brand value matching no
-- tenant yields NULL, the insert succeeds, and nothing complains. That risk
-- grows with a second brand in play, which is exactly why this lands now.
--
-- Repair the existing rows FIRST with:
--   node scripts/repair-null-tenant-suppressions.mjs --apply
-- (already run 2026-08-05: 1 row repaired, 0 remaining). This migration is the
-- backstop that keeps it from happening again, not the repair itself.
--
-- Idempotent: safe to re-run. Aborts loudly if any NULL rows remain rather than
-- silently dropping them, because every row here is a person who asked to stop.

do $$
declare
  orphan_count integer;
begin
  select count(*) into orphan_count
  from public.email_suppressions
  where tenant_id is null;

  if orphan_count > 0 then
    raise exception
      'REFUSING to add NOT NULL: % email_suppressions row(s) still have tenant_id IS NULL. '
      'Run scripts/repair-null-tenant-suppressions.mjs --apply first. These rows are '
      'people who opted out and are currently NOT being honored; do not delete them.',
      orphan_count;
  end if;
end $$;

alter table public.email_suppressions
  alter column tenant_id set not null;

-- A suppression row that cannot be tied to a tenant is a suppression that does
-- not work. Keep the FK so a deleted tenant cannot orphan one either.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'email_suppressions_tenant_id_fkey'
      and table_name = 'email_suppressions'
  ) then
    alter table public.email_suppressions
      add constraint email_suppressions_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id) on delete cascade;
  end if;
end $$;
