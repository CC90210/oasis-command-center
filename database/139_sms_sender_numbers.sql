-- 139_sms_sender_numbers.sql — the live registry of SMS sending numbers.
--
-- WHY. The drip engine picked its sending number from a hardcoded list in
-- lib/drips/rep-sms-identity.ts, "VERIFIED live 2026-07-09". TextTorrent numbers
-- get carrier-burned and rotated, and by 2026-07-13 the list had rotted:
--
--   jordan  1 of 1 numbers dead   (its ONLY live number was one the list had
--                                  deliberately dropped as "spammy")
--   joe     sub-account gone entirely
--   admin   3 of 5 dead
--
-- Every send from a dead number returns 422 Validation Error. 1,070 of them over
-- three weeks, all recorded as 'sent'. Adon confirms numbers rotate often, so a
-- static list is structurally wrong: it is a snapshot of a moving target.
--
-- This table is that target, refreshed by /api/cron/sync-sms-numbers. The send
-- path reads here; the static registry survives only as a last-ditch fallback.
--
-- RLS in this same file per the standing default.

create table if not exists public.sms_sender_numbers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  -- 'jordan' | 'alex' | 'matt' | 'admin' … matches rep-sms-identity repKey.
  rep_key       text not null,
  -- The X-ACT-AS-USER sub-account, or null for the parent/admin account.
  act_as_email  text,
  number        text not null,
  -- False once the number stops appearing in TextTorrent's active list. Rows are
  -- never deleted: a number that disappears is evidence, and the history is how
  -- rotation gets diagnosed next time.
  active        boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- When it went missing, so "how long have we been sending from a dead number"
  -- is answerable.
  deactivated_at timestamptz,
  unique (tenant_id, number)
);

create index if not exists idx_sms_numbers_lookup
  on public.sms_sender_numbers (tenant_id, rep_key, active);

alter table public.sms_sender_numbers enable row level security;
alter table public.sms_sender_numbers force  row level security;
revoke all on public.sms_sender_numbers from anon, authenticated;

drop policy if exists sms_sender_numbers_service_role on public.sms_sender_numbers;
create policy sms_sender_numbers_service_role on public.sms_sender_numbers
  for all to service_role using (true) with check (true);

drop policy if exists sms_sender_numbers_tenant_read on public.sms_sender_numbers;
create policy sms_sender_numbers_tenant_read on public.sms_sender_numbers
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
