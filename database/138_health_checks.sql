-- 138_health_checks.sql — outcome-based health check results and alert state.
--
-- Written after SMS was found dead for three weeks and email for a day, with no
-- alert on either. The existing watchdog watches 9 local PM2 processes for
-- liveness and has no visibility into the Vercel crons where both failures
-- happened. See docs/superpowers/plans/2026-08-06-fleet-health-monitoring.md.
--
-- Two tables:
--   health_check_runs   append-only history. The baseline engine reads its own
--                       history from here, so thresholds are learned rather
--                       than hand-maintained.
--   health_alert_state  one row per condition key, carrying the decay ladder
--                       state that lib/notify/alert-decay.ts expects.
--
-- RLS in this same file per the standing default.

create table if not exists public.health_check_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  check_id    text not null,
  surface     text not null default 'oasis',
  verdict     text not null check (verdict in ('ok','degraded','failing','check_broken')),
  observed    double precision,
  baseline    double precision,
  reason      text,
  ran_at      timestamptz not null default now()
);

create index if not exists idx_health_runs_check_time
  on public.health_check_runs (check_id, ran_at desc);
create index if not exists idx_health_runs_tenant_time
  on public.health_check_runs (tenant_id, ran_at desc);

create table if not exists public.health_alert_state (
  -- The CONDITION key, e.g. 'health:sms.delivered_24h'. Deliberately not the
  -- rendered message: embedding a changing number in the key defeats
  -- suppression entirely, which is the bug alert-decay.ts was written for.
  alert_key        text primary key,
  tenant_id        uuid references public.tenants(id) on delete cascade,
  last_signature   text,
  last_alerted_at  timestamptz,
  repeat_n         int not null default 0,
  -- When the condition first went bad in the current episode. Cleared on
  -- recovery so the next episode starts a fresh ladder.
  first_failed_at  timestamptz,
  updated_at       timestamptz not null default now()
);

alter table public.health_check_runs   enable row level security;
alter table public.health_check_runs   force  row level security;
alter table public.health_alert_state  enable row level security;
alter table public.health_alert_state  force  row level security;
revoke all on public.health_check_runs  from anon, authenticated;
revoke all on public.health_alert_state from anon, authenticated;

drop policy if exists health_check_runs_service_role on public.health_check_runs;
create policy health_check_runs_service_role on public.health_check_runs
  for all to service_role using (true) with check (true);

drop policy if exists health_alert_state_service_role on public.health_alert_state;
create policy health_alert_state_service_role on public.health_alert_state
  for all to service_role using (true) with check (true);

-- Tenant members may read their own health history (a future status page).
-- All writes stay service-role: a browser session must never be able to mark
-- something healthy.
drop policy if exists health_check_runs_tenant_read on public.health_check_runs;
create policy health_check_runs_tenant_read on public.health_check_runs
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
