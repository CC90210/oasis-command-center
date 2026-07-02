-- 108_operator_email_agent.sql
-- Operator Email Agent (Alex pilot) — per-user agent config + metrics.
-- Additive-only. Applied via the Bravo Management API (house doctrine).
--
-- RLS + FORCE + REVOKE + service-role policy are in THIS file (house rule
-- [[rls-required-default]]): both tables key off a user and can hold
-- deal/lender-derived signal, so no anon/authenticated access — service role only.

-- ── agent_email_settings ── the "agent": one row per (tenant, operator) ──────
create table if not exists public.agent_email_settings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  user_id           uuid not null,                 -- operator auth_user_id (e.g. Alex)
  mode              text not null default 'off'
                      check (mode in ('off','monitor','draft','semi','full')),
  work_enabled      boolean not null default true, -- monitor the work mailbox
  personal_enabled  boolean not null default false,-- monitor the personal mailbox (opt-in)
  daily_send_cap    integer not null default 100,  -- max agent-sent emails/day (fail-closed at cap)
  last_processed_at timestamptz,                    -- poller cursor
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists agent_email_settings_active_idx
  on public.agent_email_settings (last_processed_at asc nulls first)
  where mode <> 'off';

alter table public.agent_email_settings enable row level security;
alter table public.agent_email_settings force row level security;
revoke all on public.agent_email_settings from anon, authenticated;
drop policy if exists agent_email_settings_service_all on public.agent_email_settings;
create policy agent_email_settings_service_all on public.agent_email_settings
  for all to service_role using (true) with check (true);

-- ── agent_email_snapshots ── per-operator metrics time-series (dashboard) ────
create table if not exists public.agent_email_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  user_id              uuid not null,
  captured_at          timestamptz not null default now(),
  emails_in            integer not null default 0,
  emails_out           integer not null default 0,
  median_response_sec  integer,
  awaiting_reply       integer not null default 0,
  deals_with_email     integer not null default 0,
  lender_declines      integer not null default 0,
  detail               jsonb not null default '{}'::jsonb
);
create index if not exists agent_email_snapshots_lookup_idx
  on public.agent_email_snapshots (tenant_id, user_id, captured_at desc);

alter table public.agent_email_snapshots enable row level security;
alter table public.agent_email_snapshots force row level security;
revoke all on public.agent_email_snapshots from anon, authenticated;
drop policy if exists agent_email_snapshots_service_all on public.agent_email_snapshots;
create policy agent_email_snapshots_service_all on public.agent_email_snapshots
  for all to service_role using (true) with check (true);
