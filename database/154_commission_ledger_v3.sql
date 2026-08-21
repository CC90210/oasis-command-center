-- 154 — the commission ledger becomes multi-party.  [POSTGRES REFERENCE DIALECT]
--
-- NOT THE FILE THAT RUNS. Production is EMPIRE_DATA_BACKEND=turso_cloud; the
-- executable version is database/turso/154_commission_ledger_v3.turso.sql.
-- This exists so the schema stays expressible in Postgres and so the intent is
-- reviewable in the dialect the rest of database/ is written in.
--
-- Full rationale lives in the Turso companion. In brief: 147's
-- UNIQUE (tenant_id, payment_reference, entry_type) allows exactly one accrual
-- per collected payment, which is what makes a second payee impossible. The
-- sales org pays up to four people from one payment, so party_role joins the
-- key. website_deals also gains a 'starter' tier, because its CHECK is what
-- made a $500 build unrepresentable.
--
-- WHERE THE DIALECTS DIVERGE, AND WHY THIS FILE IS SHORTER
-- Postgres can ALTER a CHECK and add a UNIQUE in place, so it needs none of the
-- rename-and-replace choreography the Turso file performs. That choreography
-- exists because SQLite can do neither, and because apply_turso_migration.py
-- refuses DROP TABLE outright — so the old tables are retired by rename rather
-- than destroyed. Postgres has no equivalent constraint, and inventing retired
-- twins here would misrepresent the executable schema.
--
-- The bookkeeping-repair INSERT at the top of the Turso file is likewise
-- absent: schema_migrations is that runner's ledger, not Postgres's.

begin;

-- ---------------------------------------------------------------------------
-- website_deals — the $500 tier, and the four parties to a deal.
-- ---------------------------------------------------------------------------
alter table public.website_deals
  drop constraint if exists website_deals_package_id_check;
alter table public.website_deals
  add constraint website_deals_package_id_check
  check (package_id in ('starter','essential','growth','authority'));

alter table public.website_deals add column if not exists opener_user_id uuid;
alter table public.website_deals add column if not exists closer_user_id uuid;
alter table public.website_deals add column if not exists builder_user_id uuid;
alter table public.website_deals add column if not exists manager_user_id uuid;
alter table public.website_deals add column if not exists lead_source_track text
  not null default 'company';
alter table public.website_deals
  drop constraint if exists website_deals_lead_source_track_check;
alter table public.website_deals
  add constraint website_deals_lead_source_track_check
  check (lead_source_track in ('company','self'));
alter table public.website_deals add column if not exists book_price_cents bigint;
alter table public.website_deals add column if not exists sold_price_cents bigint;

comment on column public.website_deals.lead_source_track is
  'Which comp ladder applies. Frozen at close — re-sourcing a lead later must '
  'never re-rate a deal that has already paid out.';
comment on column public.website_deals.book_price_cents is
  'The tier''s standard price AT THE TIME OF SALE, so "sold above book" stays '
  'reconstructible after the price book moves. A rate that cannot be rebuilt '
  'from stored facts cannot be defended in a payout dispute.';

-- ---------------------------------------------------------------------------
-- website_sales_commissions — one row per PARTY per payment.
-- ---------------------------------------------------------------------------
alter table public.website_sales_commissions add column if not exists party_role text
  not null default 'full_stack';
alter table public.website_sales_commissions
  drop constraint if exists website_sales_commissions_party_role_check;
alter table public.website_sales_commissions
  add constraint website_sales_commissions_party_role_check
  check (party_role in ('opener','closer','builder','manager','full_stack'));

alter table public.website_sales_commissions add column if not exists comp_version integer
  not null default 2;
alter table public.website_sales_commissions add column if not exists basis_amount_cents bigint;
alter table public.website_sales_commissions add column if not exists rate_bps integer;
alter table public.website_sales_commissions add column if not exists amount_cents bigint;
alter table public.website_sales_commissions add column if not exists notes jsonb
  not null default '[]'::jsonb;
alter table public.website_sales_commissions add column if not exists clawback_deadline_at timestamptz;

alter table public.website_sales_commissions
  drop constraint if exists website_sales_commissions_rate_bps_check;
alter table public.website_sales_commissions
  add constraint website_sales_commissions_rate_bps_check
  check (rate_bps is null or (rate_bps >= 0 and rate_bps <= 10000));

-- THE CHANGE. One accrual per payment becomes one accrual per payment PER ROLE,
-- so an opener, a closer, a builder and a manager coexist on one payment and a
-- replay still updates those four rather than inserting duplicates.
alter table public.website_sales_commissions
  drop constraint if exists website_sales_commissions_tenant_id_payment_reference_entry_key;
create unique index if not exists website_sales_commissions_party_key
  on public.website_sales_commissions (tenant_id, payment_reference, entry_type, party_role);

comment on column public.website_sales_commissions.comp_version is
  '2 = single-payee 20/30 (migration 147). 3 = the multi-party engine '
  '(lib/website-sales-comp.ts). A re-close must never re-rate an old row under '
  'today''s rules, and a payout dispute must be reconstructible years later.';
comment on column public.website_sales_commissions.notes is
  'How the number was reached, as a JSON array of strings. A rep paid under '
  'their headline rate is owed an explanation that does not require reading '
  'code which has since changed.';

create index if not exists website_commissions_deal_idx
  on public.website_sales_commissions (tenant_id, deal_id, party_role);
create index if not exists website_commissions_clawback_idx
  on public.website_sales_commissions (tenant_id, status, clawback_deadline_at);

commit;
