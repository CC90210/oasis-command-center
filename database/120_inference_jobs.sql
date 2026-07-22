-- 120_inference_jobs.sql — subscription-CLI inference job queue.
--
-- WHY: the oasis app runs on Vercel and cannot spawn the `claude` CLI, but the
-- paid Anthropic API is a dormant fallback by doctrine (and its account can run
-- dry — which on 2026-07-21 silently killed every paid-API AI feature). This
-- queue gives Vercel a subscription path: routes INSERT a job + poll; the local
-- APEX machine's `infer-consumer` daemon (JARVIS services/infer-consumer)
-- claims it, executes via the authenticated Claude Code CLI on the Max plan,
-- and writes the result. Same proven pattern as document_extraction_jobs.
--
-- Written by:  oasis lib/bridge-infer.ts queueInfer() (service role)
-- Consumed by: JARVIS services/infer-consumer/index.js (service role)
--
-- RLS per the standing default: enabled + forced, anon/authenticated revoked,
-- service-role-only. Prompts can embed lead/merchant context — never
-- client-readable. Idempotent — safe to re-run.

create table if not exists public.inference_jobs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade,
  source        text not null,                    -- caller label, e.g. 'conversation-summarize'
  system        text,                             -- system prompt (may be null)
  prompt        text not null,                    -- user prompt (untrusted content pre-fenced by caller)
  model_tier    text not null default 'fast'
                check (model_tier in ('fast', 'smart', 'max')),
  max_tokens    int  not null default 1024 check (max_tokens between 1 and 16000),
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'complete', 'error')),
  result_text   text,
  error_message text,
  attempts      int  not null default 0,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  completed_at  timestamptz
);

-- Daemon claim query: WHERE status='pending' ORDER BY created_at ASC LIMIT 1.
create index if not exists idx_inference_jobs_due
  on public.inference_jobs (status, created_at);

alter table public.inference_jobs enable row level security;
alter table public.inference_jobs force row level security;
revoke all on public.inference_jobs from anon, authenticated;

drop policy if exists inference_jobs_service_role on public.inference_jobs;
create policy inference_jobs_service_role on public.inference_jobs
  for all to service_role using (true) with check (true);
