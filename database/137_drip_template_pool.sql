-- 137_drip_template_pool.sql — the approved drip template pool.
--
-- Adon, 2026-08-05: rotation must draw from APPROVED templates, and templates
-- written or generated outside the app must be importable into that rotation.
--
-- Replaces copy-embedded-in-drip_sequences.steps as the source of drip copy.
-- The steps stay as the FALLBACK, so an empty pool reproduces today's behaviour
-- exactly and this is safe to apply before any template is seeded.
--
-- Also closes a trap the 2026-08-05 audit found: the 14 cc_email_templates rows
-- under category 'drip:%' that the Templates UI edits are NEVER READ by the drip
-- engine. An operator could rewrite all of them and change nothing about what a
-- merchant received. This table is what the engine actually reads.
--
-- ROLE is what makes rotation coherent: templates only ever substitute for
-- others playing the same part in the arc. An opener never stands in for a last
-- call.
--
-- RLS in this same file per the standing default: enabled + forced,
-- anon/authenticated revoked, service-role full access, tenant members can read
-- their own tenant's rows. Writes go through the app's service-role client only.

create table if not exists public.drip_template_pool (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  brand        text not null check (brand in ('sunbiz', 'bluerise')),
  stage        text not null,
  role         text not null check (role in ('opener','nudge','value','question','last_call','revive')),
  subject      text not null,
  body_text    text not null,
  -- APPROVAL IS A GATE, not a label. Only 'approved' is reachable by the
  -- selector; 'draft' and 'retired' are unreachable by any seed.
  status       text not null default 'draft' check (status in ('draft','approved','retired')),
  -- 0 is a soft retire: kept for the record, never sent.
  weight       int  not null default 1 check (weight >= 0 and weight <= 100),
  source       text not null default 'ui' check (source in ('ui','seed','imported','generated')),
  created_by   uuid,
  approved_by  uuid,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The selector's lookup key.
create index if not exists idx_drip_pool_lookup
  on public.drip_template_pool (tenant_id, brand, stage, role, status);

-- An approved row must record WHO approved it and when. Approval is the control
-- that stands between a draft and a merchant's inbox, so it needs an audit
-- trail, not just a flag.
alter table public.drip_template_pool
  drop constraint if exists drip_template_pool_approval_audited;
alter table public.drip_template_pool
  add constraint drip_template_pool_approval_audited
  check (status <> 'approved' or (approved_by is not null and approved_at is not null));

alter table public.drip_template_pool enable row level security;
alter table public.drip_template_pool force row level security;
revoke all on public.drip_template_pool from anon, authenticated;

drop policy if exists drip_template_pool_service_role on public.drip_template_pool;
create policy drip_template_pool_service_role on public.drip_template_pool
  for all to service_role using (true) with check (true);

-- Read-only for tenant members, matching the pattern established by
-- 113_agent_voice_profiles.sql (user_profiles.auth_user_id, not a members
-- table). No insert/update/delete policy for authenticated: ALL writes are
-- service-role, so approval cannot be self-granted from a browser session.
-- Approval is the control standing between a draft and a merchant's inbox.
drop policy if exists drip_template_pool_tenant_read on public.drip_template_pool;
create policy drip_template_pool_tenant_read on public.drip_template_pool
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
