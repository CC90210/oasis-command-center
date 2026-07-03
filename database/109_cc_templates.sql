-- 109_cc_templates.sql — Saved Constant Contact email templates (per tenant).
--
-- Backs the Templates section of the CC console: reusable subject + preheader + HTML
-- authored in-app (the SunBiz library ships as code; these are the user-saved ones).
-- Tenant-scoped with RLS enabled in THIS file (REVOKE anon/authenticated + service_role
-- policy + tenant policy), per the 106 pattern. Not PII, but RLS is the standing default
-- for every new table.

create table if not exists public.cc_email_templates (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  category     text not null default 'custom',
  subject      text not null default '',
  preheader    text not null default '',
  html         text not null default '',
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_cc_templates_tenant on public.cc_email_templates (tenant_id, updated_at desc);

alter table public.cc_email_templates enable row level security;
alter table public.cc_email_templates force row level security;
revoke all on public.cc_email_templates from anon, authenticated;
drop policy if exists cc_email_templates_service_role on public.cc_email_templates;
create policy cc_email_templates_service_role on public.cc_email_templates for all to service_role using (true) with check (true);
drop policy if exists cc_email_templates_tenant on public.cc_email_templates;
create policy cc_email_templates_tenant on public.cc_email_templates for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
