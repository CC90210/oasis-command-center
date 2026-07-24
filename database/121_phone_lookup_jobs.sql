-- 121_phone_lookup_jobs.sql — the automated (TruePeopleSearch) phone-lookup queue.
--
-- WHY A QUEUE AND NOT AN API CALL:
-- TruePeopleSearch has no API and is protected by DataDome, which scores the
-- source ASN before it parses the request. Any datacenter IP — the VPS, and
-- Vercel's functions equally — is challenged on arrival. The lookup therefore
-- has to originate from a residential connection driving a real browser, which
-- means Adon's workstation, which has no inbound address Vercel could call.
--
-- So the call direction is inverted. Vercel (the API route an operator's click
-- hits) only ever INSERTs a row here. The local JARVIS worker
-- (services/tps-enricher) polls this table, claims a row, runs the CloakBrowser
-- scrape on the residential IP, and writes the outcome back. Nothing reaches
-- into the workstation; it reaches out. Same shape as merchant_background_checks
-- (database/106) and inference_jobs, both of which already run this way.
--
-- WHERE THIS SITS IN THE ENRICHMENT ORDER:
-- TruePeopleSearch is the automated PRIMARY. Thomson Reuters CLEAR
-- (clair_reports, database/120) is the billable, permissible-use, manual
-- FALLBACK — and lib/clair/eligibility.ts refuses a CLEAR pull until the
-- automated path has run and come up empty. The completion of a job here is
-- what stamps `phone_lookup_status` on the lead, and that stamp is the only
-- thing that opens the CLEAR gate. Break this and CLEAR becomes unreachable.
--
-- PII: query fields and results carry a real person's name, city, phone and
-- email. Service-role writes only; tenant members read their own tenant.

create table if not exists public.phone_lookup_jobs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  -- The lead this lookup is for. tenant_records is the lead/application store;
  -- ON DELETE CASCADE so a removed merchant takes its skip-trace results with
  -- it — we must not retain contact research on a deleted record.
  lead_id        uuid not null references public.tenant_records(id) on delete cascade,

  -- ── what we asked ─────────────────────────────────────────────────────────
  -- Snapshotted at enqueue time, not read live at run time: the lead may be
  -- edited between the click and the scrape, and a result must stay auditable
  -- against the question that actually produced it.
  query_first_name text,
  query_last_name  text,
  query_city       text,
  query_state      text,
  query_age        int,

  -- ── outcome ───────────────────────────────────────────────────────────────
  -- 'blocked' is deliberately distinct from 'no_results'. A bot-wall is NOT
  -- evidence that the person has no phone, and collapsing the two would let a
  -- DataDome challenge masquerade as a clean negative. [[fail-closed-default]]
  status         text not null default 'pending'
                   check (status in ('pending','running','completed','no_results','blocked','error')),
  error_message  text,

  -- Normalized result. `phones` is the point of the whole exercise:
  --   [{ number: '+1...', type: 'Wireless' | 'Landline' }]
  phones         jsonb,
  emails         jsonb,
  matched_name   text,
  matched_age    int,
  matched_city   text,
  matched_state  text,
  -- 0-100, from the scraper's name/age/state/city scoring. Rows below the
  -- worker's floor never reach 'completed' — a low-confidence match is a
  -- WRONG person's phone number, which is worse than no number at all.
  confidence     int,
  source         text,           -- 'truepeoplesearch' | 'fastpeoplesearch'
  detail_url     text,

  -- ── audit / control ───────────────────────────────────────────────────────
  attempts       int not null default 0,
  requested_by   uuid,
  requested_by_email text,
  -- 'manual' = an operator clicked. 'promote' = auto-fired on Live Subs
  -- promotion (env-gated, off until the manual path is proven).
  trigger_source text not null default 'manual',
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  completed_at   timestamptz
);

-- The worker's hot path: oldest pending first.
create index if not exists phone_lookup_jobs_pending_idx
  on public.phone_lookup_jobs (status, created_at)
  where status = 'pending';

-- AT MOST ONE UNFINISHED JOB PER LEAD, enforced by the database rather than by
-- the API route's read-then-insert. Two concurrent POSTs (two operators, or one
-- double-click) can both pass a SELECT-based dedupe check before either INSERT
-- commits, and would then both enqueue — spending two scrapes out of a daily
-- budget whose whole purpose is to protect the workstation's IP reputation.
-- The second insert now fails with 23505 and the route returns the existing job.
create unique index if not exists phone_lookup_jobs_one_in_flight_idx
  on public.phone_lookup_jobs (lead_id)
  where status in ('pending', 'running');

-- The UI's path: this lead's history, newest first. Also backs the 30-day
-- per-lead dedupe check the API route runs before enqueueing.
create index if not exists phone_lookup_jobs_lead_idx
  on public.phone_lookup_jobs (lead_id, created_at desc);

create index if not exists phone_lookup_jobs_tenant_idx
  on public.phone_lookup_jobs (tenant_id, created_at desc);

-- ── RLS (per database/071 + the 106/120 pattern) ────────────────────────────
alter table public.phone_lookup_jobs enable row level security;
alter table public.phone_lookup_jobs force row level security;

-- Policies are created only when absent rather than dropped-and-recreated. The
-- drop-first idiom used in earlier migrations means a re-run briefly leaves the
-- table with RLS forced and NO policy — a window in which the service role
-- itself is locked out — and it is also the pattern the migration guard refuses
-- to execute, on the reasonable grounds that a migration should not be able to
-- remove an access control. Creating conditionally is idempotent either way.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'phone_lookup_jobs'
      and policyname = 'phone_lookup_jobs_service_role'
  ) then
    create policy phone_lookup_jobs_service_role on public.phone_lookup_jobs
      for all to service_role using (true) with check (true);
  end if;

  -- Tenant members READ their own tenant's jobs (the panel polls for status).
  -- Writes stay service-role: the API route enqueues after a role check, and
  -- the local worker is the only thing that may declare an outcome. A client
  -- that could write here could fabricate a 'no_results' and thereby unlock a
  -- billable CLEAR pull without any lookup ever having run.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'phone_lookup_jobs'
      and policyname = 'phone_lookup_jobs_tenant_read'
  ) then
    -- NB: user_profiles joins to auth via `auth_user_id`, NOT `id`. Same
    -- predicate as merchant_background_checks (106) and clair_reports (120).
    create policy phone_lookup_jobs_tenant_read on public.phone_lookup_jobs
      for select to authenticated
      using (
        tenant_id in (
          select up.tenant_id from public.user_profiles up where up.auth_user_id = auth.uid()
        )
      );
  end if;
end
$$;

-- ── PRIVILEGES — RUN THIS MANUALLY IN THE SUPABASE SQL EDITOR ───────────────
-- This table is SERVICE-ROLE ONLY. Do NOT grant authenticated SELECT: the panel
-- reads job history through /api/leads/[id]/phone-lookup (service role), which
-- enforces per-agent lead visibility via canViewLead(). A blanket tenant_read
-- grant would let any tenant member read every lead's lookup PII directly through
-- Supabase, bypassing that per-agent boundary (Codex 2026-07-24). The
-- tenant_read POLICY above is inert without a grant and is intentionally left
-- ungranted — the API is the only read path.
--
--   revoke all on public.phone_lookup_jobs from anon, authenticated;
--   -- (do NOT run `grant select ... to authenticated`)

comment on table public.phone_lookup_jobs is
  'TruePeopleSearch skip-trace queue. Enqueued by the oasis API, executed by the '
  'LOCAL JARVIS tps-enricher worker on a residential IP (DataDome blocks every '
  'datacenter IP, so this cannot run on the VPS or on Vercel). Completing a job '
  'stamps phone_lookup_status on the lead, which is what opens the manual CLEAR '
  'fallback in lib/clair/eligibility.ts.';
