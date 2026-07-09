-- 117_call_appointments.sql — lead-centric call scheduling + call sheet.
--
-- Distinct from 115_scheduled_calls.sql (the Conversations inbox's generic
-- "request a call" reminder, thread-scoped, no lead requirement). This table
-- backs the Calls tab's per-lead CALL SHEET: schedule a call against a
-- specific lead from the lead board/drawer, then the call sheet surfaces
-- that lead's notes + MCA/underwriting summary so the rep has everything
-- during the call, plus outcome logging (completed / no_answer / rescheduled
-- / cancelled).
--
-- Written by: POST /api/call-appointments (service-role; session gate +
--   getWritableLead authorization in the route, no client insert).
-- Read by: GET /api/call-appointments (the current user's own appointments).
-- Updated by: PATCH /api/call-appointments/[id] (status/outcome/reschedule,
--   creator or assignee only).
--
-- RLS per the standing default (enabled + forced, anon/authenticated
-- revoked, service-role full — every read/write goes through the API routes
-- above, which enforce tenant + per-user scoping in application code).
-- Idempotent — safe to re-run against Bravo.

create table if not exists public.call_appointments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  lead_id         uuid not null,
  entity_type     text not null default 'lead',
  scheduled_for   timestamptz not null,
  assigned_to     uuid,
  status          text not null default 'scheduled'
                    check (status in ('scheduled', 'completed', 'no_answer', 'cancelled', 'rescheduled')),
  pre_call_note   text,
  outcome_note    text,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists idx_call_appointments_tenant_scheduled
  on public.call_appointments (tenant_id, scheduled_for);
create index if not exists idx_call_appointments_tenant_assignee_status
  on public.call_appointments (tenant_id, assigned_to, status);
create index if not exists idx_call_appointments_tenant_lead
  on public.call_appointments (tenant_id, lead_id);

alter table public.call_appointments enable row level security;
alter table public.call_appointments force row level security;
revoke all on public.call_appointments from anon, authenticated;

drop policy if exists call_appointments_service_role on public.call_appointments;
create policy call_appointments_service_role on public.call_appointments
  for all to service_role using (true) with check (true);
