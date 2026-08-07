-- 140_sms_delivery_receipts.sql — what the CARRIER did with each SMS we sent.
--
-- WHY. Between 2026-07-27 and 2026-08-07, 51 consecutive API-sent messages were
-- rejected by the carrier and every one was recorded as 'sent'. TextTorrent's
-- send endpoint returns HTTP 201 for a message the carrier will refuse; the real
-- verdict lands afterwards on the message object as `api_send_status`
-- (delivered | pending | failed) with a null `msg_sid` on failure. Nothing read
-- it, so a dead channel and a healthy one wrote identical rows.
--
-- Measured 2026-08-07 across 643 outbound messages on the same numbers:
--   platform=api (this codebase)       113 sent,  10 delivered,  98 failed
--   platform=web/app (a rep typing)    530 sent, 419 delivered,   0 failed
--
-- A receipt is opened at send time and closed by /api/cron/reconcile-sms once
-- the carrier reports. Open receipts are the reconciler's work queue; closed
-- ones feed the send breaker and the delivery-rate health check.
--
-- CONTENT. Deliberately stores a body FINGERPRINT, not the copy. TextTorrent
-- returns no message_id on send (verified live 2026-08-07), so we find our
-- message by hashing thread candidates — which identifies it exactly without
-- copying merchant-facing text into a second table. Only the last 4 digits of
-- the destination are kept, for diagnostics.
--
-- RLS in this same file per the standing default.

create table if not exists public.sms_delivery_receipts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  -- Soft references. Deliberately NOT foreign keys: a receipt is the evidence
  -- that a send failed, and it must outlive any pruning of the row that caused
  -- it. Losing the evidence is how the outage stayed invisible the first time.
  drip_run_id     uuid,
  lead_id         uuid,

  -- Everything needed to find the message again in TextTorrent.
  chat_id         text not null,
  rep_key         text,
  act_as_email    text,
  from_number     text,
  to_last4        text,
  body_hash       text not null,
  sent_at         timestamptz not null,

  -- The carrier's verdict, normalised. 'unknown' is the honest default: it means
  -- we have not read it yet, NOT that the message is fine.
  carrier_status  text not null default 'unknown'
                    check (carrier_status in ('delivered', 'failed', 'pending', 'unknown')),
  msg_sid         text,
  segments        integer,
  -- We are billed for failures too (a failed 2-segment send booked 6 credits on
  -- 2026-08-07), so spend on undelivered mail is answerable.
  credits         integer,

  check_attempts  integer not null default 0,
  last_checked_at timestamptz,
  -- Set once carrier_status is terminal. Null = still the reconciler's problem.
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- The reconciler's work queue: open receipts, oldest first.
create index if not exists idx_sms_receipts_open
  on public.sms_delivery_receipts (tenant_id, sent_at)
  where resolved_at is null;

-- The breaker and the health check both read the recent terminal window.
create index if not exists idx_sms_receipts_recent
  on public.sms_delivery_receipts (tenant_id, sent_at desc);

-- One receipt per send. A reconciler retry must update, never duplicate, or the
-- failure ratio inflates and the breaker trips on phantom traffic.
create unique index if not exists idx_sms_receipts_dedup
  on public.sms_delivery_receipts (tenant_id, chat_id, body_hash, sent_at);

alter table public.sms_delivery_receipts enable row level security;
alter table public.sms_delivery_receipts force  row level security;
revoke all on public.sms_delivery_receipts from anon, authenticated;

drop policy if exists sms_delivery_receipts_service_role on public.sms_delivery_receipts;
create policy sms_delivery_receipts_service_role on public.sms_delivery_receipts
  for all to service_role using (true) with check (true);

drop policy if exists sms_delivery_receipts_tenant_read on public.sms_delivery_receipts;
create policy sms_delivery_receipts_tenant_read on public.sms_delivery_receipts
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
