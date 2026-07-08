-- 114_scheduled_sends.sql — durable scheduled-send queue for the Conversations
-- inbox (replaces the in-tab `setTimeout` in InboxShell/SendSplitButton, which
-- silently drops a scheduled send whenever the rep closes the tab or Vercel
-- cold-redeploys).
--
-- Written by: POST /api/conversations/schedule/route.ts (service-role client;
--   the tenant/session gate + sanitize + sender-identity resolution all happen
--   in the route BEFORE insert — no client insert path).
-- Read/updated by: GET+POST /api/cron/dispatch-scheduled-sends/route.ts (Vercel
--   cron, every 5 min) — claims due 'pending' rows (flip to 'sending' first to
--   avoid double-fire), sends via the same lib functions the live routes use,
--   marks 'sent'/'failed'.
--
-- RLS in this file per the standing default: enabled + forced, anon/
-- authenticated revoked, service-role full access (all reads/writes route
-- through the two service-role paths above — no client insert/update). Tenant
-- members get a read-only policy (mirrors 113_agent_voice_profiles.sql) so the
-- inbox could show "scheduled" state via an authed client in a future phase
-- without a follow-up migration.
--
-- Idempotent — safe to re-run against Bravo (create-if-not-exists + drop/
-- recreate policies), matching the repo's migration convention.

create table if not exists public.scheduled_sends (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  lead_id         uuid,                                   -- null → not lead-linked (triage/orphan thread)
  thread_key      text not null,                           -- ConversationThread.key (lead:<uuid> | phone:<e164> | email:<addr> | id:<uuid>)
  channel         text not null check (channel in ('sms', 'email')),
  to_phone        text,                                     -- required when channel='sms'
  to_email        text,                                     -- required when channel='email'
  subject         text,                                     -- email only
  body            text not null,
  actor_user_id   uuid not null,                            -- the scheduling rep (auth_user_id) — attribution + per-rep sender resolution
  from_identity   text,                                     -- resolved sender number (sms) or mailbox address (email), captured at schedule time
  scheduled_for   timestamptz not null,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts        int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Cron claim query: WHERE status='pending' AND scheduled_for <= now() ORDER BY scheduled_for LIMIT 50.
create index if not exists idx_scheduled_sends_due
  on public.scheduled_sends (status, scheduled_for);

create index if not exists idx_scheduled_sends_tenant
  on public.scheduled_sends (tenant_id, status);

alter table public.scheduled_sends enable row level security;
alter table public.scheduled_sends force row level security;
revoke all on public.scheduled_sends from anon, authenticated;

drop policy if exists scheduled_sends_service_role on public.scheduled_sends;
create policy scheduled_sends_service_role on public.scheduled_sends
  for all to service_role using (true) with check (true);

-- Read-only for tenant members — no insert/update/delete policy for
-- authenticated: all writes go through the service-role routes above
-- (POST/DELETE /api/conversations/schedule, the dispatch cron).
drop policy if exists scheduled_sends_tenant_read on public.scheduled_sends;
create policy scheduled_sends_tenant_read on public.scheduled_sends
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
