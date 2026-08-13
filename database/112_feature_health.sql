-- 112_feature_health.sql — Global feature-health monitoring for platform admins.
--
-- WHY THIS SHAPE (read before changing it):
--
-- The 2026-08-06 fleet-health post-mortem established that "is the process up"
-- was TRUE throughout both the 3-week SMS outage and the email outage. Liveness
-- is the wrong question. So health here is a WEIGHTED SCORE over four signals,
-- and uptime is only one of them:
--
--     uptime      — did the probe answer                (liveness; weakest signal)
--     error_rate  — share of observations that errored
--     latency     — p95 against a per-check budget
--     outcome     — did the feature actually PRODUCE something, measured
--                   against its own trailing 14-day median (the signal that
--                   would have caught both outages)
--
-- A check whose process is up, fast and error-free but which has produced
-- nothing for a day scores BAD. That is the entire point.
--
-- These tables are PLATFORM-level, not tenant-level: a system admin watches
-- every tenant at once. tenant_id is therefore nullable (null = global check).
-- There is no tenant read policy — service_role only, and the dashboard reads
-- through a server route that enforces the admin check. Inventing a
-- cross-tenant RLS policy for an admin-only surface would be a wider hole than
-- the feature needs.
--
-- VERIFY AFTER APPLY:
--   select table_name from information_schema.tables
--    where table_schema='public'
--      and table_name in ('feature_health_checks','feature_health_samples',
--                         'feature_health_status','health_alert_state',
--                         'health_alert_deliveries');
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname like 'feature_health%' or relname like 'health_alert%';

-- ============================================================================
-- 1. The check registry. A check is a DECLARATION, not code.
--
-- Self-registering: the scanner upserts code-defined checks on every run, so a
-- new feature appears without a migration. Operator edits to weights/thresholds
-- survive that upsert (the scanner only writes columns marked code-owned).
-- ============================================================================
create table if not exists public.feature_health_checks (
  id            uuid primary key default gen_random_uuid(),
  check_key     text not null unique,          -- stable slug, e.g. 'sms.drip.sends'
  feature       text not null,                 -- 'SMS Drip', 'Shop-out', ...
  surface       text not null default 'oasis'
                  check (surface in ('oasis','jarvis','client','external')),
  severity      text not null default 'high'
                  check (severity in ('critical','high','medium','low')),
  enabled       boolean not null default true,
  tenant_id     uuid references public.tenants(id) on delete cascade,  -- null = global

  -- CODE-OWNED. How to observe. Re-synced from the registry each scan.
  observer_kind text not null default 'sql_count'
                  check (observer_kind in ('sql_count','sql_ratio','http_probe','freshness','custom')),
  observer_cfg  jsonb not null default '{}'::jsonb,

  -- OPERATOR-OWNED. The customizable formula. Weights need not sum to 1; the
  -- engine normalizes over the components that actually reported. A component
  -- weighted 0 is excluded entirely (that is how you say "latency is
  -- meaningless for this check").
  weights       jsonb not null default
                  '{"uptime":0.2,"error_rate":0.3,"latency":0.1,"outcome":0.4}'::jsonb,

  -- OPERATOR-OWNED. Judgement thresholds fed to the scorer.
  --   outcome_floor_pct : alert under this share of the 14d median (0.25 = 25%)
  --   latency_budget_ms : p95 at/under budget scores 1.0, 3x budget scores 0.0
  --   error_rate_ceiling: error share at/above this scores 0.0
  --   min_absolute      : an absolute floor for outcome, for low-volume checks
  --                       where a median-relative rule is noise
  --   stale_after_min   : freshness checks — minutes before the data is stale
  thresholds    jsonb not null default
                  '{"outcome_floor_pct":0.25,"latency_budget_ms":2000,"error_rate_ceiling":0.10,"min_absolute":null,"stale_after_min":null}'::jsonb,

  -- Score bands. >= healthy_at is green, >= degraded_at is amber, below is red.
  healthy_at    numeric not null default 0.80,
  degraded_at   numeric not null default 0.50,

  -- Where a breach pages. Empty = the dispatcher's default route.
  alert_channels text[] not null default '{}',

  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_fhc_enabled on public.feature_health_checks (enabled, surface);
create index if not exists idx_fhc_tenant  on public.feature_health_checks (tenant_id);

alter table public.feature_health_checks enable row level security;
alter table public.feature_health_checks force row level security;
revoke all on public.feature_health_checks from anon, authenticated;
drop policy if exists feature_health_checks_service_role on public.feature_health_checks;
create policy feature_health_checks_service_role on public.feature_health_checks
  for all to service_role using (true) with check (true);


-- ============================================================================
-- 2. The sample time series. One row per check per scan tick.
--
-- Raw components are stored ALONGSIDE the score on purpose: when a score drops
-- you must be able to say WHICH component moved without re-running anything.
-- Storing only the score is how you get an unexplainable graph.
-- ============================================================================
create table if not exists public.feature_health_samples (
  id             bigserial primary key,
  check_key      text not null references public.feature_health_checks(check_key) on delete cascade,
  observed_at    timestamptz not null default now(),

  -- Raw components, each nullable — null means "this check did not report this
  -- component", which the scorer treats as excluded, NOT as zero. Coercing a
  -- missing component to 0 would manufacture a fake outage.
  uptime         numeric,   -- 0..1
  error_rate     numeric,   -- 0..1
  latency_p95_ms integer,
  outcome_value  numeric,   -- raw observed count/ratio
  outcome_median numeric,   -- trailing 14d median for the same check

  score          numeric not null,   -- 0..1 weighted result
  status         text not null check (status in ('healthy','degraded','down','unknown')),

  -- Why it scored what it scored. Per-component normalized values + the
  -- effective weights after renormalization. This is the audit trail.
  breakdown      jsonb not null default '{}'::jsonb,
  error          text,               -- observer failure, if any

  duration_ms    integer             -- how long the observation itself took
);

create index if not exists idx_fhs_check_time on public.feature_health_samples (check_key, observed_at desc);
create index if not exists idx_fhs_time on public.feature_health_samples (observed_at desc);

alter table public.feature_health_samples enable row level security;
alter table public.feature_health_samples force row level security;
revoke all on public.feature_health_samples from anon, authenticated;
drop policy if exists feature_health_samples_service_role on public.feature_health_samples;
create policy feature_health_samples_service_role on public.feature_health_samples
  for all to service_role using (true) with check (true);


-- ============================================================================
-- 3. Current status rollup — one row per check. The dashboard reads THIS, not
-- the sample table, so the page stays O(checks) instead of O(samples).
-- ============================================================================
create table if not exists public.feature_health_status (
  check_key       text primary key references public.feature_health_checks(check_key) on delete cascade,
  score           numeric not null,
  status          text not null check (status in ('healthy','degraded','down','unknown')),
  breakdown       jsonb not null default '{}'::jsonb,
  error           text,

  -- Consecutive-tick counters. A single bad tick is noise; the dispatcher
  -- requires a run of them before it pages.
  consecutive_bad integer not null default 0,
  consecutive_ok  integer not null default 0,

  last_ok_at      timestamptz,
  last_bad_at     timestamptz,
  observed_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_fhstatus_status on public.feature_health_status (status, updated_at desc);

alter table public.feature_health_status enable row level security;
alter table public.feature_health_status force row level security;
revoke all on public.feature_health_status from anon, authenticated;
drop policy if exists feature_health_status_service_role on public.feature_health_status;
create policy feature_health_status_service_role on public.feature_health_status
  for all to service_role using (true) with check (true);


-- ============================================================================
-- 4. Alert backoff ladder state.
--
-- Keyed on the CONDITION, never the rendered message: any text carrying a
-- count or a timestamp hashes differently every tick and would never dedup.
--
-- Ladder: immediate -> 1h -> 3h -> 12h -> daily forever. It never goes fully
-- silent (an outage cannot hide) and never shouts (not an alarm clock).
--
-- This table IS the persistence the ladder needs. A module-scope latch produces
-- both failure modes at once: silent forever on a standing condition, and a
-- fresh page on every restart when the worker crash-loops.
-- ============================================================================
create table if not exists public.health_alert_state (
  condition_key   text primary key,     -- e.g. 'check_down:sms.drip.sends'
  component       text not null,
  scope           text,
  rung            integer not null default 0,   -- index into the ladder
  first_alert_at  timestamptz not null default now(),
  last_alert_at   timestamptz not null default now(),
  next_alert_at   timestamptz not null default now(),
  open            boolean not null default true,
  alert_count     integer not null default 0,
  last_text       text,
  cleared_at      timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists idx_has_open on public.health_alert_state (open, next_alert_at);

alter table public.health_alert_state enable row level security;
alter table public.health_alert_state force row level security;
revoke all on public.health_alert_state from anon, authenticated;
drop policy if exists health_alert_state_service_role on public.health_alert_state;
create policy health_alert_state_service_role on public.health_alert_state
  for all to service_role using (true) with check (true);


-- ============================================================================
-- 5. Delivery ledger — the exactly-once rail for alert dispatch.
--
-- The brief says to ASSUME retries and duplicate delivery. So delivery is
-- CLAIM-then-send: insert (condition_key, rung, channel) as 'claimed' BEFORE
-- sending. The unique constraint means a retry, a concurrent worker, or a
-- double cron tick all conflict on insert and skip. At-most-once per rung per
-- channel, enforced by the database rather than by hope.
--
-- Trade-off, stated rather than hidden: a crash between the claim and the send
-- loses ONE page. For a crash-looping worker the alert storm is the worse
-- failure, and the next ladder rung re-asserts within the hour.
-- ============================================================================
create table if not exists public.health_alert_deliveries (
  id            uuid primary key default gen_random_uuid(),
  condition_key text not null,
  rung          integer not null,
  channel       text not null check (channel in ('telegram','email','sms','webhook','log')),
  status        text not null default 'claimed'
                  check (status in ('claimed','sent','failed','skipped')),
  attempts      integer not null default 0,
  provider_ref  text,
  error         text,
  body_preview  text,          -- PII-redacted, first 280 chars, for audit only
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (condition_key, rung, channel)
);

create index if not exists idx_had_condition on public.health_alert_deliveries (condition_key, created_at desc);
create index if not exists idx_had_status on public.health_alert_deliveries (status, created_at desc);

alter table public.health_alert_deliveries enable row level security;
alter table public.health_alert_deliveries force row level security;
revoke all on public.health_alert_deliveries from anon, authenticated;
drop policy if exists health_alert_deliveries_service_role on public.health_alert_deliveries;
create policy health_alert_deliveries_service_role on public.health_alert_deliveries
  for all to service_role using (true) with check (true);
