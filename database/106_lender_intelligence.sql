-- 106_lender_intelligence.sql — capture per-lender × paper-type outcomes so the
-- recommender can learn which lender likes which paper (and why it declines).
--
-- Additive + idempotent (IF NOT EXISTS). RLS enabled IN THIS FILE (service_role
-- full + tenant-scoped read/write), plain unique indexes for PostgREST onConflict.
-- Applied to the Bravo Supabase via the Management API (additive-only).
--
-- Two tables:
--   lender_reply_outcomes — one row per matched-lender reply to a shopped deal,
--     with the structured decline reason + offer terms + confidence. Written by
--     app/api/cron/scan-lender-replies.
--   deal_paper_snapshot   — the deal's paper profile FROZEN at shop time (one per
--     shop run). Written by app/api/applications/[id]/shop-out/run. The recommender
--     joins outcomes -> snapshots (by application) to score lenders on similar paper.

-- ── lender_reply_outcomes ────────────────────────────────────────────────────
create table if not exists public.lender_reply_outcomes (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  application_id        uuid not null,
  lender_id            uuid not null,
  shop_run_id           uuid,
  outcome               text not null, -- approved|counter_offer|declined|info_needed|submitted|no_response|unknown
  decline_reason_code   text,          -- allowlisted taxonomy (lib/lenders/classify-reply)
  decline_reason_detail text,          -- lender's verbatim reason (bounded)
  offer_amount          numeric,
  offer_term_months     integer,
  offer_factor          numeric,
  conditions            jsonb not null default '[]'::jsonb,
  confidence            numeric,
  reply_at              timestamptz not null,
  classified_at         timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  unique (tenant_id, application_id, lender_id, reply_at)
);

create index if not exists lender_reply_outcomes_lender_idx on public.lender_reply_outcomes (tenant_id, lender_id, reply_at desc);
create index if not exists lender_reply_outcomes_app_idx on public.lender_reply_outcomes (tenant_id, application_id);

alter table public.lender_reply_outcomes enable row level security;
alter table public.lender_reply_outcomes force row level security;
revoke all on public.lender_reply_outcomes from anon, authenticated;
create policy lender_reply_outcomes_service_role on public.lender_reply_outcomes for all to service_role using (true) with check (true);
create policy lender_reply_outcomes_tenant on public.lender_reply_outcomes for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ── deal_paper_snapshot ──────────────────────────────────────────────────────
create table if not exists public.deal_paper_snapshot (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  application_id          uuid not null,
  shop_run_id             uuid not null,
  paper_grade             text,
  position_count          integer,
  total_mca_balance       numeric,
  leverage_ratio          numeric,
  monthly_revenue         numeric,
  nsf_count               numeric,
  avg_daily_balance       numeric,
  months_covered          integer,
  applicant_fico          integer,
  time_in_business_months integer,
  industry                text,
  merchant_state          text,
  requested_amount        numeric,
  captured_at             timestamptz not null default now(),
  unique (tenant_id, shop_run_id)
);

create index if not exists deal_paper_snapshot_app_idx on public.deal_paper_snapshot (tenant_id, application_id, captured_at desc);

alter table public.deal_paper_snapshot enable row level security;
alter table public.deal_paper_snapshot force row level security;
revoke all on public.deal_paper_snapshot from anon, authenticated;
create policy deal_paper_snapshot_service_role on public.deal_paper_snapshot for all to service_role using (true) with check (true);
create policy deal_paper_snapshot_tenant on public.deal_paper_snapshot for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
