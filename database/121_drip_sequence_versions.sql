-- 121_drip_sequence_versions.sql — edit history for drip sequence templates.
--
-- Every PATCH that changes a sequence's steps snapshots the PRIOR copy here,
-- so a bad template edit during re-templating is reversible and attributable.
-- Append-only from the API (no update/delete surface); restore = a normal
-- guarded PATCH that writes the old steps back (which itself snapshots).

create table if not exists public.drip_sequence_versions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  sequence_id  uuid not null references public.drip_sequences(id) on delete cascade,
  name         text not null,
  steps        jsonb not null,
  edited_by    uuid,
  created_at   timestamptz not null default now()
);

create index if not exists idx_drip_seq_versions_seq
  on public.drip_sequence_versions (tenant_id, sequence_id, created_at desc);

alter table public.drip_sequence_versions enable row level security;
alter table public.drip_sequence_versions force row level security;
revoke all on public.drip_sequence_versions from anon, authenticated;
drop policy if exists drip_seq_versions_service_role on public.drip_sequence_versions;
create policy drip_seq_versions_service_role on public.drip_sequence_versions for all to service_role using (true) with check (true);
drop policy if exists drip_seq_versions_tenant on public.drip_sequence_versions;
create policy drip_seq_versions_tenant on public.drip_sequence_versions for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
