-- 105_outreach_intel.sql — Outreach intelligence (TextTorrent campaign metrics,
-- conversion attribution, per-number health, list scoring).
--
-- Five tables, all tenant-scoped with RLS enabled in THIS file (REVOKE anon/
-- authenticated + service_role policy + tenant policy), per database/071. The
-- collector writes via the service role (bypasses RLS); the dashboard reads
-- under the tenant policy. Plain (non-partial) unique indexes for onConflict
-- upserts (the migration-093 lesson).

-- 1. Launch ledger — one row per launched campaign (the anchor everything joins on).
create table if not exists public.campaign_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  tt_campaign_id text not null,
  campaign_name text,
  list_id       text,
  list_name     text,
  sender_numbers text[],
  message       text,
  launched_by   uuid,
  dry_run       boolean not null default false,
  launched_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (tenant_id, tt_campaign_id)
);
alter table public.campaign_runs enable row level security;
alter table public.campaign_runs force row level security;
revoke all on public.campaign_runs from anon, authenticated;
drop policy if exists campaign_runs_service_role on public.campaign_runs;
create policy campaign_runs_service_role on public.campaign_runs for all to service_role using (true) with check (true);
drop policy if exists campaign_runs_tenant on public.campaign_runs;
create policy campaign_runs_tenant on public.campaign_runs for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- 2. Per-message roster snapshot (delivery + the NATIVE inbound reply).
create table if not exists public.campaign_recipients (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  tt_campaign_id  text not null,
  send_to         text,
  send_to_last10  text,
  send_from       text,
  send_status     text,
  received        boolean not null default false,
  received_message text,
  lead_id         uuid,
  conversion_stage text,
  last_status_at  timestamptz not null default now(),
  unique (tt_campaign_id, send_to_last10)
);
create index if not exists idx_camp_recip_from on public.campaign_recipients (send_from);
create index if not exists idx_camp_recip_last10 on public.campaign_recipients (send_to_last10);
create index if not exists idx_camp_recip_camp on public.campaign_recipients (tt_campaign_id);
alter table public.campaign_recipients enable row level security;
alter table public.campaign_recipients force row level security;
revoke all on public.campaign_recipients from anon, authenticated;
drop policy if exists campaign_recipients_service_role on public.campaign_recipients;
create policy campaign_recipients_service_role on public.campaign_recipients for all to service_role using (true) with check (true);
drop policy if exists campaign_recipients_tenant on public.campaign_recipients;
create policy campaign_recipients_tenant on public.campaign_recipients for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- 3. Per-campaign metric time series (deltas / sparklines without re-hitting TT).
create table if not exists public.campaign_metric_snapshots (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  tt_campaign_id  text not null,
  snapshot_at     timestamptz not null default now(),
  total           int,
  delivered       int,
  failed          int,
  reply_count     int,
  reply_rate      numeric,
  conversion_count int,
  conversion_rate numeric,
  credits_consumed int,
  status          text
);
create index if not exists idx_camp_snap on public.campaign_metric_snapshots (tt_campaign_id, snapshot_at desc);
alter table public.campaign_metric_snapshots enable row level security;
alter table public.campaign_metric_snapshots force row level security;
revoke all on public.campaign_metric_snapshots from anon, authenticated;
drop policy if exists campaign_metric_snapshots_service_role on public.campaign_metric_snapshots;
create policy campaign_metric_snapshots_service_role on public.campaign_metric_snapshots for all to service_role using (true) with check (true);
drop policy if exists campaign_metric_snapshots_tenant on public.campaign_metric_snapshots;
create policy campaign_metric_snapshots_tenant on public.campaign_metric_snapshots for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- 4. Per-sender-number health rollup (latest-wins; powers the spammy-number alert).
create table if not exists public.campaign_number_health (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  send_from     text not null,
  window_key    text not null default 'global',
  sent          int,
  delivered     int,
  failed        int,
  replies       int,
  failure_rate  numeric,
  reply_rate    numeric,
  health        text,
  last_alerted_at timestamptz,
  last_alert_signature text,
  last_computed_at timestamptz not null default now(),
  unique (tenant_id, send_from, window_key)
);
alter table public.campaign_number_health enable row level security;
alter table public.campaign_number_health force row level security;
revoke all on public.campaign_number_health from anon, authenticated;
drop policy if exists campaign_number_health_service_role on public.campaign_number_health;
create policy campaign_number_health_service_role on public.campaign_number_health for all to service_role using (true) with check (true);
drop policy if exists campaign_number_health_tenant on public.campaign_number_health;
create policy campaign_number_health_tenant on public.campaign_number_health for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- 5. Per-list intelligence rollup (scoring + dead-list verdict).
create table if not exists public.list_intelligence (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  list_id         text not null,
  list_name       text,
  campaigns_count int,
  total_sent      int,
  total_replies   int,
  total_conversions int,
  reply_rate      numeric,
  conversion_rate numeric,
  score           numeric,
  verdict         text,
  last_campaign_at timestamptz,
  last_alerted_at  timestamptz,
  last_computed_at timestamptz not null default now(),
  unique (tenant_id, list_id)
);
alter table public.list_intelligence enable row level security;
alter table public.list_intelligence force row level security;
revoke all on public.list_intelligence from anon, authenticated;
drop policy if exists list_intelligence_service_role on public.list_intelligence;
create policy list_intelligence_service_role on public.list_intelligence for all to service_role using (true) with check (true);
drop policy if exists list_intelligence_tenant on public.list_intelligence;
create policy list_intelligence_tenant on public.list_intelligence for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
