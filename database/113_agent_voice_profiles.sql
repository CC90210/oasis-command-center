-- 113_agent_voice_profiles.sql — Per-rep AI voice profiles (SMS + email,
-- distilled separately) backing the Conversations composer's "Suggest"
-- affordance (plan §6.1/§6.3, compiled-tumbling-gem.md Phase 2).
--
-- Written by the JARVIS worker services/tt-agent/voice-profile-refresher.js
-- (daily cron, Max-subscription CLI, human-authored-message corpus only —
-- see [[project_silent_failure_audit]] / ACTIVE_WORK.md for the worker).
-- Read by oasis app/api/conversations/voice-suggest/route.ts via the
-- service-role client (lib/supabase-server.ts getServiceSupabase), scoped
-- by an explicit `.eq("tenant_id", ...)` in the query itself.
--
-- NOTE: this table was already applied directly to the Bravo project via
-- the Management API (see ~/.claude/projects/.../memory/reference_bravo_db_migrations.md)
-- ahead of this file landing in git — this migration is the repo-of-record
-- copy so `database/` stays the source of truth for schema history. It is
-- idempotent (create-if-not-exists + drop/recreate policies) so re-running
-- it against Bravo is a no-op.
--
-- RLS in this file per the standing default: enabled + forced, anon/
-- authenticated revoked, service-role full access (writes are JARVIS-only —
-- no oasis route ever writes this table), tenant members can read their own
-- tenant's rows (mirrors the tenant_records / cc_email_templates pattern).

create table if not exists public.agent_voice_profiles (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  rep_user_id          uuid not null,
  channel              text not null check (channel in ('sms', 'email')),
  style_descriptors    jsonb not null default '{}'::jsonb,
  compiled_prompt      text,
  example_snippets     jsonb not null default '[]'::jsonb,
  source_message_count int not null default 0,
  confidence           text not null default 'low' check (confidence in ('low', 'med', 'high')),
  corpus_window_start  timestamptz,
  corpus_window_end    timestamptz,
  model_used           text,
  refreshed_at         timestamptz not null default now(),
  unique (tenant_id, rep_user_id, channel)
);

create index if not exists idx_agent_voice_profiles_tenant_rep
  on public.agent_voice_profiles (tenant_id, rep_user_id);

alter table public.agent_voice_profiles enable row level security;
alter table public.agent_voice_profiles force row level security;
revoke all on public.agent_voice_profiles from anon, authenticated;

drop policy if exists agent_voice_profiles_service_role on public.agent_voice_profiles;
create policy agent_voice_profiles_service_role on public.agent_voice_profiles
  for all to service_role using (true) with check (true);

-- Read-only for tenant members (oasis routes currently read via the
-- service-role client with an explicit tenant_id filter, not this policy —
-- kept in-file so a future authed-client read path is safe by default
-- without a follow-up migration). No insert/update/delete policy for
-- authenticated: writes are service-role (JARVIS worker) only.
drop policy if exists agent_voice_profiles_tenant_read on public.agent_voice_profiles;
create policy agent_voice_profiles_tenant_read on public.agent_voice_profiles
  for select
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
