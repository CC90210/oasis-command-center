-- 141_sms_breaker_probes.sql — the cross-process lease for the half-open probe.
--
-- WHY. When the SMS breaker is halted it lets ONE send through every 30 minutes
-- to test whether the carrier route recovered. That guarantee was enforced by a
-- process-local cache, which is not a guarantee at all on Vercel: dispatch runs
-- concurrently (cron plus external pingers), and each instance would see
-- "probe due", clear only its own cache, and send. The comment and the test
-- both claimed one probe while the system could fire several into a dead route.
--
-- One row per tenant, claimed by a conditional UPDATE:
--
--   update sms_breaker_probes set last_probe_at = now()
--    where tenant_id = $1 and last_probe_at < $cutoff
--   returning tenant_id;
--
-- Postgres serialises writers on the row, so exactly one caller sees the old
-- value and gets a row back. Everyone else gets zero rows and holds.
--
-- RLS in this same file per the standing default.

create table if not exists public.sms_breaker_probes (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  -- Epoch default so the FIRST probe after a halt can claim immediately rather
  -- than waiting out an interval it never actually used.
  last_probe_at timestamptz not null default 'epoch',
  updated_at    timestamptz not null default now()
);

alter table public.sms_breaker_probes enable row level security;
alter table public.sms_breaker_probes force  row level security;
revoke all on public.sms_breaker_probes from anon, authenticated;

drop policy if exists sms_breaker_probes_service_role on public.sms_breaker_probes;
create policy sms_breaker_probes_service_role on public.sms_breaker_probes
  for all to service_role using (true) with check (true);

drop policy if exists sms_breaker_probes_tenant_read on public.sms_breaker_probes;
create policy sms_breaker_probes_tenant_read on public.sms_breaker_probes
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
