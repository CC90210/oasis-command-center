-- 131_funded_deals.sql — the table behind the Renewals tab.
--
-- WHY THIS IS A CREATE, NOT AN ALTER: /renewals and /t/<slug>/renewals have been
-- shipped and wired since the Phase 8 restructure, reading funded_deals via
-- getRenewalsSummary + getRenewalsRows. The table was never created. Both
-- queries route a missing-table error through _isMissingTable() and return
-- empty, so the page has always rendered its "No funded deals yet" state rather
-- than an error — which is why nobody noticed. Verified 2026-07-29 against the
-- live database: no relation named funded_deals in any schema (148 public
-- tables). Creating it is what "activate the renewals tab" actually means; the
-- UI needs no changes.
--
-- Written by:  app/api/renewals/route.ts (manual entry, service role)
-- Consumed by: lib/queries.ts getRenewalsSummary + getRenewalsRows
--
-- RLS per the standing default, in this same file: enabled + forced,
-- anon/authenticated revoked, service-role only. This table holds merchant and
-- contact names alongside funding amounts — PII plus commercial terms, never
-- client-readable. Idempotent — safe to re-run.

create table if not exists public.funded_deals (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,

  -- Identity of the deal. merchant_name is what the Renewals rows group on.
  merchant_name      text not null,
  contact_name       text,
  -- The funder. Internal-only: never rendered on a merchant-facing surface,
  -- because SunBiz positions AS the direct lender. [[feedback_never_mention_lenders]]
  lender_name        text,
  -- Optional link back to the originating lead/application record.
  lead_id            uuid,
  application_id     uuid,

  -- Terms as the operator enters them.
  funded_amount_usd  numeric(14,2) not null check (funded_amount_usd > 0),
  factor_rate        numeric(5,3)  check (factor_rate is null or (factor_rate >= 1.0 and factor_rate <= 2.0)),
  term_months        int           check (term_months is null or (term_months between 1 and 60)),
  -- Commission points, as a percentage of the funded amount (e.g. 12.5 = 12.5%).
  points_pct         numeric(6,3)  check (points_pct is null or (points_pct >= 0 and points_pct <= 100)),

  funded_at          date not null,

  -- DERIVED ON WRITE, never typed by hand — see app/api/renewals/route.ts.
  --   next_renewal_date = funded_at + (term_months * 0.5 months)   [Adon, 2026-07-29]
  --   est_commission_usd = funded_amount_usd * points_pct / 100
  -- Stored rather than computed in the query because getRenewalsSummary and
  -- getRenewalsRows both read them directly, and the renewal date is the field
  -- the whole tab sorts and buckets on.
  next_renewal_date  date,
  est_commission_usd numeric(14,2),

  notes              text,
  source             text not null default 'manual_entry',
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- getRenewalsRows: WHERE tenant_id = $1 ORDER BY next_renewal_date ASC NULLS LAST.
create index if not exists idx_funded_deals_tenant_renewal
  on public.funded_deals (tenant_id, next_renewal_date);

-- Supports the duplicate check on manual entry (same merchant, same funded date).
create index if not exists idx_funded_deals_tenant_merchant
  on public.funded_deals (tenant_id, lower(merchant_name), funded_at);

alter table public.funded_deals enable row level security;
alter table public.funded_deals force row level security;
revoke all on public.funded_deals from anon, authenticated;

drop policy if exists funded_deals_service_role on public.funded_deals;
create policy funded_deals_service_role on public.funded_deals
  for all to service_role using (true) with check (true);

-- Keep updated_at honest without making every caller remember it.
create or replace function public.funded_deals_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_funded_deals_touch on public.funded_deals;
create trigger trg_funded_deals_touch
  before update on public.funded_deals
  for each row execute function public.funded_deals_touch_updated_at();

comment on table public.funded_deals is
  'Funded MCA deals. Feeds the Renewals tab. next_renewal_date and est_commission_usd are derived on write, not entered.';
