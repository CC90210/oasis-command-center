-- 120_gmail_templates.sql — plain-text Gmail templates for lead outreach and
-- cold email blasts, with attached Solara (AI) copy variants.
--
-- subject/body are PLAIN TEXT ONLY — the API layer rejects HTML on every
-- write path (create, update, and Solara generation). `variants` is a jsonb
-- array of { id, label, subject, body, source, created_at } objects managed
-- exclusively server-side (clients never supply variant payloads directly).
-- Stage keys come from lib/sunbiz-stage-meta LEAD_PIPELINE_STAGES + 'general'.

create table if not exists public.gmail_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  stage       text not null default 'general',
  subject     text not null default '',
  body        text not null default '',
  variants    jsonb not null default '[]'::jsonb,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gmail_templates_tenant on public.gmail_templates (tenant_id, updated_at desc);
create index if not exists idx_gmail_templates_stage on public.gmail_templates (tenant_id, stage);

alter table public.gmail_templates enable row level security;
alter table public.gmail_templates force row level security;
revoke all on public.gmail_templates from anon, authenticated;
drop policy if exists gmail_templates_service_role on public.gmail_templates;
create policy gmail_templates_service_role on public.gmail_templates for all to service_role using (true) with check (true);
drop policy if exists gmail_templates_tenant on public.gmail_templates;
create policy gmail_templates_tenant on public.gmail_templates for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
