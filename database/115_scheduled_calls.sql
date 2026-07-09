-- 115_scheduled_calls.sql — in-house call scheduling for the Conversations inbox
-- ("Request a call" button). A durable booking the rep sets from a thread; the
-- dispatch cron reminds the rep when it's due (and can place the Kixie alley-oop).
-- Google Calendar 2-way sync is a later phase; for now the UI also offers the
-- existing Google Calendar deep-link so the booking drops into the rep's calendar.
--
-- Written by: POST /api/conversations/schedule-call (service-role; session gate +
--   validation in the route, no client insert). DELETE cancels a pending booking.
-- Read/updated by: GET+POST /api/cron/dispatch-scheduled-calls (Vercel cron) and
--   the Calls tab (tenant read-only).
--
-- RLS per the standing default (enabled + forced, anon/authenticated revoked,
-- service-role full, tenant members read-only), mirroring 114_scheduled_sends.sql.
-- Idempotent — safe to re-run against Bravo.

create table if not exists public.scheduled_calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  lead_id        uuid,
  thread_key     text,                                     -- ConversationThread.key, when booked from a thread
  to_phone       text,                                     -- the number to call
  contact_label  text,                                     -- display name at booking time
  actor_user_id  uuid not null,                            -- the rep who booked / will make the call
  scheduled_for  timestamptz not null,
  notes          text,
  status         text not null default 'pending'
                   check (status in ('pending', 'done', 'cancelled', 'missed')),
  reminded_at    timestamptz,                              -- when the dispatch cron reminded the rep
  created_at     timestamptz not null default now()
);

create index if not exists idx_scheduled_calls_due
  on public.scheduled_calls (status, scheduled_for);
create index if not exists idx_scheduled_calls_tenant
  on public.scheduled_calls (tenant_id, status, scheduled_for);

alter table public.scheduled_calls enable row level security;
alter table public.scheduled_calls force row level security;
revoke all on public.scheduled_calls from anon, authenticated;

drop policy if exists scheduled_calls_service_role on public.scheduled_calls;
create policy scheduled_calls_service_role on public.scheduled_calls
  for all to service_role using (true) with check (true);

drop policy if exists scheduled_calls_tenant_read on public.scheduled_calls;
create policy scheduled_calls_tenant_read on public.scheduled_calls
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
