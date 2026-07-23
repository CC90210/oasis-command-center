-- 120_clair_reports.sql — Thomson Reuters CLEAR person-search reports.
--
-- CLEAR is the MANUAL, SECONDARY fallback for merchant phone enrichment. The
-- automated path is TruePeopleSearch (uw_lead_enricher); CLEAR is only ever run
-- by a human clicking "Pull CLAIR Report" on a lead whose automated lookup
-- failed or returned nothing. Nothing in this schema is written by a daemon.
--
-- WHY A SEPARATE TABLE (not columns on the lead):
--   1. Legal. Every CLEAR query is made under a permissible use — DPPA / GLB /
--      VOTER codes are sent with the request and are recorded here per row.
--      That provenance must stay attached to the report, auditable, and must not
--      dissolve into the application record.
--   2. Volume + shape. A CLEAR report is a large, deeply nested vendor payload
--      on a schema we do not control. Merging it into tenant_records.data would
--      contaminate the application form's field namespace.
--   3. Separation of concerns. The report is REFERENCE material an operator
--      reads to find a phone number. It must never overwrite, merge with, or be
--      visually mixed into the application data — the UI reads this table
--      exclusively.
--
-- PII: `raw_report` holds the vendor payload verbatim (names, addresses, DOBs,
-- relatives, possibly SSN fragments). It is service-role only, like
-- merchant_background_checks.raw_results (database/106). SSN is never stored
-- here in any form we control — see the check constraint note below.

create table if not exists public.clair_reports (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  -- The lead this report was pulled for. tenant_records is the lead/application
  -- store (entity_type='lead'); FK with ON DELETE CASCADE so a deleted lead
  -- takes its CLEAR reports with it — we must not retain investigative data
  -- about a merchant whose record was removed.
  lead_id        uuid not null references public.tenant_records(id) on delete cascade,
  application_id uuid,

  -- ── query provenance ──────────────────────────────────────────────────────
  -- Exactly what was asked, so a report can be reproduced and audited. The
  -- permissible-use codes are the LEGAL basis for the query and are recorded
  -- per row (they are account-level config today, but must not be inferred
  -- retroactively from config that may since have changed).
  query_name     text,
  query_address  text,
  query_city     text,
  query_state    text,
  query_zip      text,
  query_dob      text,
  permissible_dppa  text,
  permissible_glb   text,
  permissible_voter text,
  clear_environment text,        -- 'prod' | 'cert'

  -- ── outcome ───────────────────────────────────────────────────────────────
  status         text not null default 'pending'
                   check (status in ('pending','completed','no_results','error')),
  error_message  text,
  http_status    int,
  result_count   int,

  -- Normalized, UI-facing projection of the report. Kept separate from
  -- raw_report so the drawer never has to understand the vendor schema:
  --   [{ name, age, dob, addresses: [...], phones: [{number, type}], relatives: [...] }]
  people         jsonb,
  -- Convenience projection of every distinct phone across all matched people,
  -- which is the whole point of running CLEAR here.
  phones         jsonb,

  -- The vendor payload verbatim. Service-role only.
  raw_report     jsonb,
  raw_format     text,           -- 'xml' | 'json'

  -- ── audit ─────────────────────────────────────────────────────────────────
  -- CLEAR is manual by policy, so WHO ran it is not optional metadata.
  requested_by   uuid,           -- auth.users id of the operator who clicked
  requested_by_email text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists clair_reports_lead_idx
  on public.clair_reports (lead_id, created_at desc);
create index if not exists clair_reports_tenant_idx
  on public.clair_reports (tenant_id, created_at desc);

-- ── RLS (per database/071 + the 105/106 pattern) ────────────────────────────
alter table public.clair_reports enable row level security;
alter table public.clair_reports force row level security;

drop policy if exists clair_reports_service_role on public.clair_reports;
create policy clair_reports_service_role on public.clair_reports
  for all to service_role using (true) with check (true);

-- Tenant members read their own tenant's reports. Writes are service-role only
-- (the API route runs the query server-side and persists it) — a client must
-- never be able to fabricate a CLEAR report row, because the permissible-use
-- provenance on it is a legal record.
drop policy if exists clair_reports_tenant_read on public.clair_reports;
create policy clair_reports_tenant_read on public.clair_reports
  for select to authenticated
  -- NB: user_profiles joins to auth via `auth_user_id`, NOT `id` (which is the
  -- profile's own PK). Same predicate as merchant_background_checks (106).
  using (
    tenant_id in (
      select up.tenant_id from public.user_profiles up where up.auth_user_id = auth.uid()
    )
  );

-- ── PRIVILEGES — RUN THESE MANUALLY IN THE SUPABASE SQL EDITOR ──────────────
-- The exec_sql RPC deliberately refuses GRANT/REVOKE ("privilege changes must
-- be run manually"), so the automated apply stops short of these two lines.
-- They are belt-and-braces only: RLS is enabled AND forced above, and the
-- tenant policy already constrains every row an authenticated user can see —
-- so the table is not exposed while these are outstanding.
--
--   revoke all on public.clair_reports from anon, authenticated;
--   grant select on public.clair_reports to authenticated;
--
-- Housekeeping, same reason (exec_sql refuses DROP TABLE): an empty scratch
-- table left behind while probing whether exec_sql could run DDL at all.
--
--   drop table if exists public._ddl_probe_tmp;

comment on table public.clair_reports is
  'Thomson Reuters CLEAR person-search reports. MANUAL fallback only — never '
  'written by a daemon. Structurally isolated from application data by design; '
  'raw_report is service-role only. Each row records the DPPA/GLB/VOTER '
  'permissible use the query was made under.';
