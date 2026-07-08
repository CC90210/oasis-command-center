-- ============================================================================
-- Migration 112 — Conversations spine (persistent threads + workflow state)
--
-- Renumbered from the draft `110_conversations_spine.sql` (apex/conversations-
-- inbox worktree) — 110 collided across parallel sessions, and 111 landed
-- first (`lead_interactions.from_phone` as a REAL column). This is that same
-- draft with two fixes applied while renumbering (plan §7):
--
--   (a) Renumber 110 -> 112.
--   (b) from_email sourcing — the earlier apply attempt broke because
--       `from_email` was never populated as a real column by any existing
--       writer (the n8n inbound RPC and others historically stored it only
--       at `metadata->>'from_email'`). This version:
--         - backfills the new `from_email` COLUMN from `metadata->>'from_email'`
--           for historical rows (§1b, one-time, idempotent), and
--         - has the trigger + backfill CTE read `from_email` as
--           `coalesce(from_email, metadata->>'from_email', ...)` so a writer
--           that still only sets metadata (until callers are updated to write
--           the column directly) is not silently dropped going forward.
--       `from_phone` needs NO such fallback — migration 111 made it a real
--       column and every writer (TT inbound webhook, send routes) already
--       populates it directly, so the trigger sources it straight off NEW.
--
-- WHY: The Conversations inbox derives threads from lead_interactions at
-- read-time (lib/conversation-threading.ts), capped at ~400 rows/load, with
-- NO persistent per-thread state — so assignment, status (open/needs_reply/
-- waiting_on_client/closed/snoozed/triage), unread counts, snooze, and triage
-- cannot be stored, and the list can't paginate or filter server-side.
--
-- This migration keeps lead_interactions as THE message ledger (migration 003
-- forbids a second one) and adds a thin materialized spine on top:
--   * lead_interactions gains provider / provider_message_id / from_email +
--     a PLAIN unique index for true cross-provider idempotency.
--   * conversation_threads — one row per contact thread, maintained by an
--     AFTER-INSERT trigger on lead_interactions so EVERY writer (dashboard
--     routes, webhooks, JARVIS rep workers) keeps threads current.
--   * conversation_events — workflow/audit log.
--   * channel_accounts — non-secret sender/receiver registry (rep ⇄ mailbox/
--     DID); credentials stay encrypted in tenant/user_integration_credentials.
--   * tenant_records functional indexes so lead-matching stops being an
--     unindexed ILIKE %last10% JSONB scan.
--
-- INDEX CHOICE (migration-093 lesson): the (provider, provider_message_id)
-- dedup index is PLAIN (non-partial) so PostgREST `onConflict` can target it.
-- Postgres treats NULLs as DISTINCT, so rows without a provider id (internal
-- notes, TT poll rows) are unconstrained; non-null pairs collapse to one row.
--
-- TRIGGER FAILS OPEN: thread maintenance is a denormalized convenience; the
-- ledger insert is source of truth and MUST always succeed. The trigger wraps
-- its body in EXCEPTION WHEN OTHERS → RAISE WARNING + return, so a thread-
-- aggregate edge case can never drop a live SMS/email row. (This is not a
-- security guard — those fail closed; this is a materialized view maintainer.)
--
-- Idempotent: ADD COLUMN / CREATE ... IF NOT EXISTS, CREATE OR REPLACE,
-- DROP TRIGGER IF EXISTS, DO-block policies, and a null-guarded UPDATE.
-- Safe to re-apply. --allow-rls.
--
-- VERIFY AFTER APPLY (see footer).
-- ============================================================================

-- ── 1. Extend the ledger ────────────────────────────────────────────────────
alter table public.lead_interactions
  add column if not exists provider            text,
  add column if not exists provider_message_id text,
  add column if not exists from_email          text;

-- Plain (non-partial) composite unique: NULLs distinct → unconstrained;
-- non-null (provider, provider_message_id) pairs dedupe. onConflict-targetable.
create unique index if not exists ux_lead_interactions_provider_msg
  on public.lead_interactions (provider, provider_message_id);

-- ── 1b. Backfill from_email from metadata (fix for the earlier apply break) ─
-- Historical writers (e.g. the n8n inbound RPC) stored the sender address
-- only at metadata->>'from_email', never in a real column. One-time,
-- idempotent — only touches rows where the real column is still null, so
-- re-running is a no-op once caught up.
update public.lead_interactions
   set from_email = metadata->>'from_email'
 where from_email is null
   and metadata->>'from_email' is not null
   and metadata->>'from_email' <> '';

-- ── 2. Pure helper functions (mirror lib/conversation-threading.ts) ──────────
-- Canonical E.164 normalizer — MUST match normalizePhoneE164() exactly.
create or replace function public.conv_normalize_phone(raw text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if raw is null then return null; end if;
  d := regexp_replace(raw, '\D', '', 'g');
  if left(btrim(raw), 1) = '+' and length(d) between 8 and 15 then return '+' || d; end if;
  if length(d) = 11 and left(d, 1) = '1' then return '+' || d; end if;
  if length(d) = 10 then return '+1' || d; end if;
  if length(d) between 8 and 15 then return '+' || d; end if;
  return null;
end;
$$;

-- Platform classifier — MUST match messageSource() branch order exactly.
create or replace function public.conv_message_source(p_channel text, p_agent_source text, p_provider text)
returns text language sql immutable as $$
  select case
    when lower(coalesce(p_channel, '')) = 'email' then 'email'
    when lower(coalesce(p_agent_source, '')) = 'kixie' or lower(coalesce(p_provider, '')) = 'kixie' or lower(coalesce(p_channel, '')) = 'phone' then 'kixie'
    when lower(coalesce(p_agent_source, '')) = 'twilio' or lower(coalesce(p_provider, '')) = 'twilio' then 'twilio'
    when lower(coalesce(p_agent_source, '')) in ('texttorrent', 'helios') or lower(coalesce(p_provider, '')) = 'texttorrent' then 'texttorrent'
    when lower(coalesce(p_channel, '')) = 'sms' then 'texttorrent'
    else 'other'
  end;
$$;

-- ── 3. conversation_threads (the spine) ─────────────────────────────────────
create table if not exists public.conversation_threads (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  thread_key         text not null,                 -- lead:<uuid> | phone:<E164> | email:<addr> | id:<uuid>
  lead_id            uuid,                           -- null → triage
  contact_phone_e164 text,
  contact_email      text,
  contact_label      text,
  owner_agent_id     text,                           -- owning rep auth_user_id (lowercased), mirrors tenant_records.data.assigned_to
  assigned_to        text,
  status             text not null default 'open',   -- open|needs_reply|waiting_on_client|closed|snoozed|triage
  priority           text,
  last_message_at    timestamptz,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  last_direction     text,
  last_preview       text,
  unread_count       int  not null default 0,
  channel_summary    jsonb not null default '{}'::jsonb,
  sources            text[] not null default '{}',
  tags               text[] not null default '{}',
  snoozed_until      timestamptz,
  last_read_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, thread_key)
);
create index if not exists idx_conv_threads_status   on public.conversation_threads (tenant_id, status, last_message_at desc);
create index if not exists idx_conv_threads_assigned on public.conversation_threads (tenant_id, assigned_to, last_message_at desc);
create index if not exists idx_conv_threads_lead     on public.conversation_threads (tenant_id, lead_id);
create index if not exists idx_conv_threads_recent   on public.conversation_threads (tenant_id, last_message_at desc);

-- ── 4. conversation_events (workflow/audit log) ─────────────────────────────
create table if not exists public.conversation_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  thread_id     uuid references public.conversation_threads(id) on delete cascade,
  lead_id       uuid,
  event_type    text not null,                       -- assigned|status_changed|note|triage_linked|send_failed|opt_out|read|snoozed|reopened|merged
  actor_user_id uuid,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_conv_events_thread on public.conversation_events (thread_id, created_at desc);
create index if not exists idx_conv_events_tenant on public.conversation_events (tenant_id, created_at desc);

-- ── 5. channel_accounts (non-secret sender/receiver registry) ───────────────
create table if not exists public.channel_accounts (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null references public.tenants(id) on delete cascade,
  provider                     text not null,         -- texttorrent|twilio|email
  owner_user_id                text,                  -- owning rep auth_user_id (lowercased)
  display_name                 text,
  from_email                   text,
  from_phone                   text,
  texttorrent_act_as_email     text,
  twilio_messaging_service_sid text,
  twilio_phone_sid             text,
  capabilities                 jsonb not null default '{}'::jsonb,
  credential_ref               text,                  -- pointer into *_integration_credentials; SECRETS STAY THERE
  is_active                    boolean not null default true,
  is_dry_run                   boolean not null default false,
  metadata                     jsonb not null default '{}'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
-- Deterministic inbound routing (partial: integrity only, not upsert targets).
create unique index if not exists ux_channel_accounts_email
  on public.channel_accounts (tenant_id, provider, lower(from_email)) where from_email is not null;
create unique index if not exists ux_channel_accounts_phone
  on public.channel_accounts (tenant_id, provider, from_phone) where from_phone is not null;
create index if not exists idx_channel_accounts_owner on public.channel_accounts (tenant_id, owner_user_id);

-- ── 6. Thread-maintenance trigger (AFTER INSERT on the ledger, fails OPEN) ───
create or replace function public.conv_thread_upsert() returns trigger language plpgsql as $$
declare
  v_key     text;
  v_phone   text;
  v_email   text;
  v_source  text;
  v_at      timestamptz;
  v_inbound boolean;
  v_prev    text;
begin
  if NEW.tenant_id is null then return NEW; end if;
  v_at      := coalesce(NEW.sent_at, NEW.created_at, now());
  v_inbound := (NEW.direction = 'inbound');
  v_prev    := coalesce(NEW.content_preview, NEW.subject, '');
  -- from_phone is a REAL column since migration 111 — every writer (TT inbound
  -- webhook, send routes) sets it directly, so no metadata fallback needed.
  v_phone   := public.conv_normalize_phone(
                 case when v_inbound then coalesce(NEW.from_phone, NEW.to_phone)
                      else coalesce(NEW.to_phone, NEW.from_phone) end);
  -- from_email: some existing writers (e.g. the n8n inbound RPC) still only
  -- set metadata->>'from_email', not the real column added in §1 above — so
  -- fall back to metadata until every writer is migrated to the column.
  v_email   := nullif(lower(
                 case when v_inbound then coalesce(NEW.from_email, NEW.metadata->>'from_email', NEW.to_email)
                      else coalesce(NEW.to_email, NEW.from_email, NEW.metadata->>'from_email') end), '');
  if    NEW.lead_id is not null then v_key := 'lead:'  || NEW.lead_id::text;
  elsif v_phone   is not null   then v_key := 'phone:' || v_phone;
  elsif v_email   is not null   then v_key := 'email:' || v_email;
  else                               v_key := 'id:'    || NEW.id::text;
  end if;
  v_source := public.conv_message_source(NEW.channel, NEW.agent_source, NEW.metadata->>'provider');

  insert into public.conversation_threads as t (
    tenant_id, thread_key, lead_id, contact_phone_e164, contact_email,
    status, last_message_at, last_inbound_at, last_outbound_at, last_direction, last_preview,
    unread_count, channel_summary, sources, updated_at
  ) values (
    NEW.tenant_id, v_key, NEW.lead_id, v_phone, v_email,
    case when NEW.lead_id is null then 'triage' when v_inbound then 'needs_reply' else 'open' end,
    v_at,
    case when v_inbound then v_at else null end,
    case when v_inbound then null else v_at end,
    NEW.direction, v_prev,
    case when v_inbound then 1 else 0 end,
    case when NEW.channel is not null then jsonb_build_object(NEW.channel, true) else '{}'::jsonb end,
    case when v_source <> 'other' then array[v_source] else '{}'::text[] end,
    now()
  )
  on conflict (tenant_id, thread_key) do update set
    lead_id            = coalesce(t.lead_id, excluded.lead_id),
    contact_phone_e164 = coalesce(t.contact_phone_e164, excluded.contact_phone_e164),
    contact_email      = coalesce(t.contact_email, excluded.contact_email),
    last_message_at    = greatest(coalesce(t.last_message_at, v_at), v_at),
    last_inbound_at    = case when v_inbound then greatest(coalesce(t.last_inbound_at, v_at), v_at) else t.last_inbound_at end,
    last_outbound_at   = case when v_inbound then t.last_outbound_at else greatest(coalesce(t.last_outbound_at, v_at), v_at) end,
    last_direction     = case when v_at >= coalesce(t.last_message_at, v_at) then NEW.direction else t.last_direction end,
    last_preview       = case when v_at >= coalesce(t.last_message_at, v_at) then v_prev else t.last_preview end,
    unread_count       = case when v_inbound then t.unread_count + 1 else t.unread_count end,
    status             = case
                           when t.status = 'closed' and not v_inbound then t.status
                           when v_inbound and t.lead_id is null and excluded.lead_id is null then 'triage'
                           when v_inbound then 'needs_reply'
                           when t.status = 'needs_reply' then 'waiting_on_client'
                           else t.status end,
    channel_summary    = t.channel_summary || case when NEW.channel is not null then jsonb_build_object(NEW.channel, true) else '{}'::jsonb end,
    sources            = case when v_source <> 'other' and not (v_source = any(t.sources)) then array_append(t.sources, v_source) else t.sources end,
    updated_at         = now();

  return NEW;
exception when others then
  -- FAIL OPEN: never let thread maintenance block the ledger insert.
  raise warning 'conv_thread_upsert skipped for lead_interactions.id=%: %', NEW.id, sqlerrm;
  return NEW;
end;
$$;

drop trigger if exists trg_conv_thread_upsert on public.lead_interactions;
create trigger trg_conv_thread_upsert after insert on public.lead_interactions
  for each row execute function public.conv_thread_upsert();

-- ── 7. One-time backfill (idempotent: on conflict do nothing) ───────────────
-- Historical inbound is treated as already-read (unread_count = 0); new inbound
-- increments via the trigger. channel_summary starts empty and populates going
-- forward (chips read `sources`, which IS backfilled). Safe to re-run.
with keyed as (
  select
    li.id, li.tenant_id, li.lead_id, li.direction, li.channel,
    coalesce(li.sent_at, li.created_at) as at,
    (li.direction = 'inbound') as inbound,
    public.conv_normalize_phone(
      case when li.direction = 'inbound' then coalesce(li.from_phone, li.to_phone)
           else coalesce(li.to_phone, li.from_phone) end) as cphone,
    nullif(lower(
      case when li.direction = 'inbound' then coalesce(li.from_email, li.metadata->>'from_email', li.to_email)
           else coalesce(li.to_email, li.from_email, li.metadata->>'from_email') end), '') as cemail,
    coalesce(li.content_preview, li.subject, '') as prev,
    public.conv_message_source(li.channel, li.agent_source, li.metadata->>'provider') as csource
  from public.lead_interactions li
  where coalesce(li.sent_at, li.created_at) is not null and li.tenant_id is not null
),
keyed2 as (
  select k.*,
    case when k.lead_id is not null then 'lead:'  || k.lead_id::text
         when k.cphone  is not null then 'phone:' || k.cphone
         when k.cemail  is not null then 'email:' || k.cemail
         else 'id:' || k.id::text end as tkey
  from keyed k
),
latest as (
  select distinct on (tenant_id, tkey)
    tenant_id, tkey, direction as last_dir, prev as last_prev, lead_id, cphone, cemail
  from keyed2
  order by tenant_id, tkey, at desc, id desc
),
agg as (
  select tenant_id, tkey,
    max(at) as last_message_at,
    max(at) filter (where inbound) as last_inbound_at,
    max(at) filter (where not inbound) as last_outbound_at,
    coalesce(array_agg(distinct csource) filter (where csource <> 'other'), '{}'::text[]) as sources
  from keyed2 group by tenant_id, tkey
)
insert into public.conversation_threads (
  tenant_id, thread_key, lead_id, contact_phone_e164, contact_email,
  status, last_message_at, last_inbound_at, last_outbound_at, last_direction, last_preview,
  unread_count, channel_summary, sources, created_at, updated_at)
select
  a.tenant_id, a.tkey, l.lead_id, l.cphone, l.cemail,
  case when l.lead_id is null then 'triage' when l.last_dir = 'inbound' then 'needs_reply' else 'open' end,
  a.last_message_at, a.last_inbound_at, a.last_outbound_at, l.last_dir, l.last_prev,
  0, '{}'::jsonb, a.sources, now(), now()
from agg a join latest l using (tenant_id, tkey)
on conflict (tenant_id, thread_key) do nothing;

-- ── 8. tenant_records identity indexes (kill the ILIKE %last10% scan) ───────
create index if not exists idx_tenant_records_email_lower
  on public.tenant_records (tenant_id, lower(data->>'email'))
  where entity_type = 'lead';
create index if not exists idx_tenant_records_phone_last10
  on public.tenant_records (tenant_id, right(regexp_replace(coalesce(data->>'phone', ''), '\D', '', 'g'), 10))
  where entity_type = 'lead';

-- ── 9. RLS (canonical intent, per 105_outreach_intel.sql / 071) ─────────────
-- Enforcement = ENABLE + FORCE row level security + a service_role policy + a
-- tenant policy. Anon gets NO policy, so forced RLS denies it by default (this
-- replaces the belt-and-suspenders REVOKE, which the apply guard hard-blocks).
-- Policies use idempotent DO-blocks (duplicate_object caught) instead of
-- DROP POLICY (also guard-blocked) so the file is safe to re-apply.
alter table public.conversation_threads enable row level security;
alter table public.conversation_threads force row level security;
do $$ begin
  create policy conversation_threads_service_role on public.conversation_threads for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy conversation_threads_tenant on public.conversation_threads for all
    using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
exception when duplicate_object then null; end $$;

alter table public.conversation_events enable row level security;
alter table public.conversation_events force row level security;
do $$ begin
  create policy conversation_events_service_role on public.conversation_events for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy conversation_events_tenant on public.conversation_events for all
    using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
exception when duplicate_object then null; end $$;

alter table public.channel_accounts enable row level security;
alter table public.channel_accounts force row level security;
do $$ begin
  create policy channel_accounts_service_role on public.channel_accounts for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy channel_accounts_tenant on public.channel_accounts for all
    using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
exception when duplicate_object then null; end $$;

-- ============================================================================
-- VERIFY AFTER APPLY (idempotent — safe to run this whole file twice):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='lead_interactions'
--      AND column_name IN ('provider','provider_message_id','from_email');
--   SELECT indexname FROM pg_indexes WHERE tablename='lead_interactions'
--      AND indexname='ux_lead_interactions_provider_msg';
--   SELECT to_regclass('public.conversation_threads'),
--          to_regclass('public.conversation_events'),
--          to_regclass('public.channel_accounts');
--   SELECT count(*) FROM public.conversation_threads;               -- backfill sanity
--   SELECT count(*) FROM public.lead_interactions
--    WHERE from_email IS NULL AND metadata->>'from_email' IS NOT NULL;  -- should be 0
--   SELECT tgname FROM pg_trigger WHERE tgname='trg_conv_thread_upsert';
--   SELECT public.conv_normalize_phone('(860) 452-7608');           -- → +18604527608
--   SELECT public.conv_message_source('sms','twilio',null);         -- → twilio
-- ============================================================================
