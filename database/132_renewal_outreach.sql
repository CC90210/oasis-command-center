-- Canonical lender links + idempotent 50%-term renewal outreach ledger.
alter table public.funded_deals
  add column if not exists lender_id uuid references public.tenant_records(id) on delete set null;

create index if not exists idx_funded_deals_tenant_lender
  on public.funded_deals(tenant_id, lender_id);

create table if not exists public.renewal_outreach_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  funded_deal_id uuid not null references public.funded_deals(id) on delete cascade,
  lead_id uuid,
  lender_id uuid references public.tenant_records(id) on delete set null,
  assigned_agent_id uuid,
  event_kind text not null default '50_percent' check (event_kind in ('50_percent')),
  threshold_date date not null,
  status text not null check (status in ('review_required','pending','queued','sent','blocked','failed','cancelled')),
  scheduled_send_id uuid references public.scheduled_sends(id) on delete set null,
  internal_email_at timestamptz,
  telegram_at timestamptz,
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(funded_deal_id, event_kind)
);

create index if not exists idx_renewal_outreach_tenant_status
  on public.renewal_outreach_events(tenant_id, status, threshold_date);

alter table public.renewal_outreach_events enable row level security;
alter table public.renewal_outreach_events force row level security;
revoke all on public.renewal_outreach_events from anon, authenticated;

drop policy if exists renewal_outreach_service_role on public.renewal_outreach_events;
create policy renewal_outreach_service_role on public.renewal_outreach_events
  for all to service_role using (true) with check (true);

drop policy if exists renewal_outreach_tenant_read on public.renewal_outreach_events;
create policy renewal_outreach_tenant_read on public.renewal_outreach_events
  for select using (
    tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid())
  );
