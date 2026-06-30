-- 106_merchant_background_checks.sql — Merchant background-check queue + results.
--
-- One row per background check on a signed application: identity snapshot captured
-- at enqueue time (from the full application), the queue status the JARVIS
-- bg-check-worker drives, and the structured findings the SunBiz software's BGC tab
-- renders. Tenant-scoped with RLS enabled in THIS file (REVOKE anon/authenticated +
-- service_role policy + tenant policy), per database/071 + the 105 pattern.
--
-- The worker writes via the service role (bypasses RLS); the dashboard reads under
-- the tenant policy. SSN/EIN are stored as last4 ONLY (tokenized upstream) — never
-- raw. raw_results holds the (PII-bearing) external response and stays service-role.

create table if not exists public.merchant_background_checks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  lead_id          uuid,
  application_id   text,

  -- Full identity snapshot captured from the signed application (search inputs +
  -- match-confirmation signals). SSN/EIN are last4 only, never raw.
  business_name        text,
  dba                  text,
  state                text,
  owner_name           text,
  partner_name         text,
  owner_email          text,
  owner_phone          text,
  owner_home_address   text,
  business_address     text,
  owner_dob            text,
  ein_last4            text,
  ssn_last4            text,

  -- Queue + results.
  status           text not null default 'pending'
                     check (status in ('pending','running','completed','error','needs_assist')),
  risk_flag        text not null default 'none'
                     check (risk_flag in ('none','court_case','mca_default','ucc','lien','bankruptcy','unknown')),
  findings         jsonb,              -- [{ source, court, index_number, caption, parties, filed_date, case_type, risk, match_confidence, matched_on[] }]
  findings_summary text,
  sources_run      text[],
  raw_results      jsonb,              -- service-role only (may carry PII)
  error            text,
  checked_at       timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_mbc_queue on public.merchant_background_checks (status, created_at);
create index if not exists idx_mbc_lead on public.merchant_background_checks (lead_id, created_at desc);
create index if not exists idx_mbc_tenant on public.merchant_background_checks (tenant_id, checked_at desc);

alter table public.merchant_background_checks enable row level security;
alter table public.merchant_background_checks force row level security;
revoke all on public.merchant_background_checks from anon, authenticated;
drop policy if exists merchant_background_checks_service_role on public.merchant_background_checks;
create policy merchant_background_checks_service_role on public.merchant_background_checks for all to service_role using (true) with check (true);
drop policy if exists merchant_background_checks_tenant on public.merchant_background_checks;
create policy merchant_background_checks_tenant on public.merchant_background_checks for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
