-- 115_drip_runs.sql — Vercel-native drip send schedule (replaces the broken
-- VPS `sequence_runner`/`sequence_state` path — see
-- ~/.claude/plans/compiled-tumbling-gem.md for the full architecture).
--
-- Both SMS (TextTorrent) and email (submissions@ SMTP) already work natively
-- from Vercel — the same paths Conversations + shop-out use live today. This
-- table is a SEPARATE, oasis-owned schedule (distinct from `sequence_state`,
-- which the VPS runner still polls but never actually sends from) so there is
-- no collision, no shared unique-index race, and no hard dependency on
-- stopping the VPS runner.
--
-- Written by: /api/cron/enroll-drips (Vercel cron, ~15 min) — inserts one row
--   per lead at step_index=0 when the lead's tenant_records.data.stage
--   matches an enabled drip_sequences.trigger_filter.to and the lead has no
--   active (scheduled|sending) drip_runs row for that sequence yet.
-- Read/updated by: /api/cron/dispatch-drips (Vercel cron, ~5 min) — claims
--   due 'scheduled' rows (CAS flip to 'sending' to avoid double-fire), sends
--   via lib/drips/send.ts, marks 'sent'/'failed'/'done', and inserts the next
--   step's row on advance.
--
-- RLS in this file per the standing default (matches 114_scheduled_sends.sql):
-- enabled + forced, anon/authenticated revoked, service-role full access (all
-- reads/writes route through the two cron routes above — no client insert
-- path). Tenant members get a read-only policy for a future ops view.
--
-- Idempotent — safe to re-run against Bravo (create-if-not-exists + drop/
-- recreate policies), matching the repo's migration convention.

create table if not exists public.drip_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  lead_id         uuid not null,                            -- tenant_records.id (entity_type='lead')
  sequence_id     uuid not null,                             -- drip_sequences.id
  sequence_name   text not null,                             -- snapshot of drip_sequences.name at enroll time (survives a rename)
  step_index      int not null default 0,                    -- index into drip_sequences.steps
  channel         text not null check (channel in ('sms', 'email')),
  scheduled_for   timestamptz not null,
  status          text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled', 'done')),
  attempts        int not null default 0,
  last_error      text,
  from_identity   text,                                      -- resolved sender number (sms) or mailbox address (email), captured at send time
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Cron claim query: WHERE status='scheduled' AND scheduled_for <= now() ORDER BY scheduled_for LIMIT 50.
create index if not exists idx_drip_runs_due
  on public.drip_runs (status, scheduled_for);

create index if not exists idx_drip_runs_tenant
  on public.drip_runs (tenant_id, status);

-- Never-double-enroll: at most one ACTIVE (scheduled|sending) run per
-- (tenant, lead, sequence). A completed/failed/cancelled row doesn't block a
-- future re-enrollment (e.g. the lead re-enters the same stage later) — the
-- partial index only covers the two non-terminal statuses. This is what makes
-- enroll-drips idempotent: re-running it never creates a duplicate active row
-- for a lead already mid-sequence, and the DB (not application logic) is the
-- final guard against a race between two overlapping enroll invocations.
create unique index if not exists uq_drip_runs_active_per_lead_sequence
  on public.drip_runs (tenant_id, lead_id, sequence_id)
  where status in ('scheduled', 'sending');

alter table public.drip_runs enable row level security;
alter table public.drip_runs force row level security;
revoke all on public.drip_runs from anon, authenticated;

drop policy if exists drip_runs_service_role on public.drip_runs;
create policy drip_runs_service_role on public.drip_runs
  for all to service_role using (true) with check (true);

-- Read-only for tenant members — no insert/update/delete policy for
-- authenticated: all writes go through the two service-role cron routes
-- above.
drop policy if exists drip_runs_tenant_read on public.drip_runs;
create policy drip_runs_tenant_read on public.drip_runs
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
