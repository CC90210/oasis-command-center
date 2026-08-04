-- Escalating repeat-suppression state for ops watchdogs.
--
-- tps-backlog-watch had no alert state at all, so it re-alerted on a flat 6-hour
-- cadence for as long as a condition stood. On 2026-08-03 that meant ten days of
-- identical TPS backlog messages into the shared OASIS group — true every time,
-- and read by nobody after day three.
--
-- Generic on purpose: any cron watchdog that alerts on a STANDING condition
-- (rather than an event) can key into this table instead of growing its own
-- bespoke last_alerted_at column. See lib/notify/alert-decay.ts for the ladder.

create table if not exists public.ops_alert_state (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Stable name of the watchdog, e.g. 'tps_backlog'.
  alert_key text not null,
  -- COARSE identity of the condition. Must not embed a live age or an exact
  -- count: those change every run, mint a new identity each time and defeat
  -- suppression entirely — which is the original bug ('oldest ~236.7h').
  condition_signature text not null,
  last_alerted_at timestamptz not null default now(),
  -- Position on the decay ladder within the current episode (1 = first alert).
  repeat_n int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, alert_key)
);

create index if not exists idx_ops_alert_state_tenant_key
  on public.ops_alert_state(tenant_id, alert_key);

alter table public.ops_alert_state enable row level security;
alter table public.ops_alert_state force row level security;

-- Service-role only. This is cron bookkeeping — no browser client ever reads or
-- writes it, so there is no permissive policy to get wrong.
drop policy if exists ops_alert_state_service_all on public.ops_alert_state;
create policy ops_alert_state_service_all
  on public.ops_alert_state
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ops_alert_state is
  'Repeat-suppression state for standing-condition ops alerts. Written only by cron routes via the service role; see lib/notify/alert-decay.ts.';

-- campaign_number_health already tracks last_alerted_at + last_alert_signature,
-- but had no ladder position — so collect-outreach-intel's gate was
-- `(signatureChanged || cooled)`, an OR that re-fired every 12h forever for an
-- unchanged condition. That is why the same "+1860…452…7608 is getting blocked —
-- 22% failure" message arrived daily. One column turns that flat cooldown into
-- the same decaying ladder.
alter table public.campaign_number_health
  add column if not exists repeat_n int not null default 1;

