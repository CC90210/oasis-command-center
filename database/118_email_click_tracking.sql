-- 118_email_click_tracking.sql — email CLICK tracking (sibling to
-- email_open_events, migration 050) + drip_runs.provider_message_id.
--
-- Why: the SunBiz "Metrics" dashboard needs click-through, and Adon's rule
-- "a click auto-moves the lead to viewed_application" needs a durable click
-- event to fire the stage engine. A click is a stronger engagement signal than
-- an open (Apple Mail Privacy Protection prefetches the open pixel but never
-- follows a link), so clicks drive the forward stage move while opens stay
-- prefetch-guarded. The /api/track/click/[id] route is the ONLY writer, via the
-- service role.
--
-- provider_message_id: the rfc822 Message-Id the executor now persists at send
-- time so a future bounce DSN (Ship 2 bounce reader) can be correlated back to
-- the exact drip send.
--
-- RLS per the standing default (matches 115_drip_runs.sql): enabled + forced,
-- anon/authenticated revoked, service-role full access, tenant members get a
-- read-only policy for the Metrics ops view. Idempotent — safe to re-run.

create table if not exists public.email_click_events (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  outbound_message_id text not null,                 -- = lead_interactions.id of the send (the click [id])
  lead_id             uuid,
  clicked_url         text,                           -- destination the recipient was redirected to
  user_agent          text,
  ip_hash             text,
  clicked_at          timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index if not exists idx_email_click_events_tenant_lead
  on public.email_click_events (tenant_id, lead_id, clicked_at desc);
create index if not exists idx_email_click_events_message
  on public.email_click_events (outbound_message_id);
-- One row per (message, recipient-ip) — re-clicks from the same recipient
-- collapse. MUST be a NON-partial unique index: the route upserts with
-- ON CONFLICT (outbound_message_id, ip_hash), and PostgREST rejects a PARTIAL
-- index as an ON CONFLICT target ("42P10: no unique or exclusion constraint
-- matching") — the exact bug that left the sibling email_open_events dedup
-- (a partial index) inserting ZERO rows in prod. NULLs are distinct by default,
-- so anonymous clicks (ip_hash null) still always insert (accepted over-count).
drop index if exists public.idx_email_click_events_dedup;
create unique index if not exists idx_email_click_events_dedup
  on public.email_click_events (outbound_message_id, ip_hash);

-- HOTFIX (same class of bug): email_open_events' dedup index is PARTIAL
-- (WHERE ip_hash IS NOT NULL), so /api/track/open's upsert ON CONFLICT
-- (outbound_message_id, ip_hash) has failed on EVERY open since it shipped —
-- prod email_open_events has 0 rows. Open-rate feeds the Metrics tab, so
-- rebuild it as a non-partial unique index. email_open_events had 0 rows, so
-- the drop/recreate can't collide.
drop index if exists public.idx_email_open_events_dedup;
create unique index if not exists idx_email_open_events_dedup
  on public.email_open_events (outbound_message_id, ip_hash);

alter table public.email_click_events enable row level security;
alter table public.email_click_events force row level security;
revoke all on public.email_click_events from anon, authenticated;

drop policy if exists email_click_events_service_role on public.email_click_events;
create policy email_click_events_service_role on public.email_click_events
  for all to service_role using (true) with check (true);

-- Read-only for tenant members — the only writer is the service-role track route.
drop policy if exists email_click_events_tenant_read on public.email_click_events;
create policy email_click_events_tenant_read on public.email_click_events
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- Correlation key: rfc822 Message-Id of the drip email send → matched by the
-- Ship 2 bounce reader against inbound DSNs. Nullable + indexed only when set.
alter table public.drip_runs add column if not exists provider_message_id text;
create index if not exists idx_drip_runs_provider_message_id
  on public.drip_runs (provider_message_id) where provider_message_id is not null;
