-- Tenant-scoped SunBiz agent runtime. Credentials remain in encrypted stores.
create table if not exists public.sunbiz_agent_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null, provider text not null default 'texttorrent' check (provider='texttorrent'),
  display_name text not null, act_as_email text not null, from_number text not null,
  application_url text not null, handoff_user_id uuid,
  timezone text not null default 'America/New_York',
  mode text not null default 'semi' check (mode in ('off','shadow','semi','full','paused')),
  daily_cap integer not null default 250 check (daily_cap between 0 and 5000),
  voice_profile_id uuid, knowledge_version text not null, enabled boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id,user_id,provider), unique (tenant_id,provider,from_number)
);
create table if not exists public.sunbiz_conversation_state (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider='texttorrent'), provider_conversation_id text not null,
  lead_id uuid, agent_account_id uuid references public.sunbiz_agent_accounts(id) on delete set null,
  qualification_state jsonb not null default '{}'::jsonb, last_intent text, last_action text,
  automation_paused boolean not null default false, human_owner_id uuid,
  knowledge_version text not null, provider_cursor text, retry_count integer not null default 0,
  last_error text, updated_at timestamptz not null default now(),
  unique (tenant_id,provider,provider_conversation_id)
);
create table if not exists public.sunbiz_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_state_id uuid not null references public.sunbiz_conversation_state(id) on delete cascade,
  agent_account_id uuid not null references public.sunbiz_agent_accounts(id) on delete restrict,
  lead_id uuid, thread_key text not null, to_phone text not null,
  original_text text not null check (char_length(original_text) between 1 and 1600),
  final_text text check (final_text is null or char_length(final_text) between 1 and 1600),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','sent','failed')),
  intent text not null, confidence numeric(5,4), model_id text, model_version text,
  knowledge_version text not null, source_interaction_id uuid, provider_message_id text,
  approved_by uuid, approved_at timestamptz, rejected_by uuid, rejected_at timestamptz,
  handoff_user_id uuid, handoff_at timestamptz,
  scheduled_send_id uuid references public.scheduled_sends(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id,source_interaction_id)
);
create table if not exists public.sunbiz_processing_leases (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  partition_key text not null, owner_id text not null, acquired_at timestamptz not null default now(),
  expires_at timestamptz not null, heartbeat_at timestamptz not null default now(),
  primary key (tenant_id,partition_key)
);
create table if not exists public.sunbiz_provider_rate_state (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider='texttorrent'), window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count>=0), blocked_until timestamptz,
  updated_at timestamptz not null default now(), primary key (tenant_id,provider)
);
create table if not exists public.texttorrent_inbound_work (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agent_account_id uuid references public.sunbiz_agent_accounts(id) on delete set null,
  provider_message_id text not null, provider_conversation_id text,
  source_interaction_id uuid, priority integer not null default 100,
  status text not null default 'pending' check (status in ('pending','running','complete','dead')),
  attempts integer not null default 0, available_at timestamptz not null default now(),
  claimed_by text, claimed_at timestamptz, lease_expires_at timestamptz,
  last_error text, created_at timestamptz not null default now(), completed_at timestamptz,
  unique (tenant_id,provider_message_id)
);
create table if not exists public.texttorrent_dead_letters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  inbound_work_id uuid references public.texttorrent_inbound_work(id) on delete set null,
  provider_message_id text not null, failure_code text not null, failure_detail text,
  attempts integer not null, payload_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), resolved_at timestamptz
);
alter table public.inference_jobs add column if not exists metadata jsonb not null default '{}'::jsonb;
create index if not exists idx_sunbiz_drafts_queue on public.sunbiz_reply_drafts(tenant_id,status,created_at);
create index if not exists idx_sunbiz_state_agent on public.sunbiz_conversation_state(tenant_id,agent_account_id,updated_at desc);
create index if not exists idx_sunbiz_leases_expiry on public.sunbiz_processing_leases(expires_at);
create index if not exists idx_tt_inbound_due on public.texttorrent_inbound_work(status,priority,available_at);
alter table public.sunbiz_agent_accounts enable row level security;
alter table public.sunbiz_agent_accounts force row level security;
alter table public.sunbiz_conversation_state enable row level security;
alter table public.sunbiz_conversation_state force row level security;
alter table public.sunbiz_reply_drafts enable row level security;
alter table public.sunbiz_reply_drafts force row level security;
alter table public.sunbiz_processing_leases enable row level security;
alter table public.sunbiz_processing_leases force row level security;
alter table public.sunbiz_provider_rate_state enable row level security;
alter table public.sunbiz_provider_rate_state force row level security;
alter table public.texttorrent_inbound_work enable row level security;
alter table public.texttorrent_inbound_work force row level security;
alter table public.texttorrent_dead_letters enable row level security;
alter table public.texttorrent_dead_letters force row level security;
revoke all on public.sunbiz_agent_accounts, public.sunbiz_conversation_state, public.sunbiz_reply_drafts,
  public.sunbiz_processing_leases, public.sunbiz_provider_rate_state from anon, authenticated;
revoke all on public.texttorrent_inbound_work, public.texttorrent_dead_letters from anon, authenticated;
drop policy if exists sunbiz_accounts_service_role on public.sunbiz_agent_accounts;
drop policy if exists sunbiz_state_service_role on public.sunbiz_conversation_state;
drop policy if exists sunbiz_drafts_service_role on public.sunbiz_reply_drafts;
drop policy if exists sunbiz_leases_service_role on public.sunbiz_processing_leases;
drop policy if exists sunbiz_rate_service_role on public.sunbiz_provider_rate_state;
drop policy if exists tt_inbound_work_service_role on public.texttorrent_inbound_work;
drop policy if exists tt_dead_letters_service_role on public.texttorrent_dead_letters;
create policy sunbiz_accounts_service_role on public.sunbiz_agent_accounts for all to service_role using(true) with check(true);
create policy sunbiz_state_service_role on public.sunbiz_conversation_state for all to service_role using(true) with check(true);
create policy sunbiz_drafts_service_role on public.sunbiz_reply_drafts for all to service_role using(true) with check(true);
create policy sunbiz_leases_service_role on public.sunbiz_processing_leases for all to service_role using(true) with check(true);
create policy sunbiz_rate_service_role on public.sunbiz_provider_rate_state for all to service_role using(true) with check(true);
create policy tt_inbound_work_service_role on public.texttorrent_inbound_work for all to service_role using(true) with check(true);
create policy tt_dead_letters_service_role on public.texttorrent_dead_letters for all to service_role using(true) with check(true);

create or replace function public.claim_texttorrent_partition(partition_key text, worker_id text, lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  insert into sunbiz_processing_leases(tenant_id,partition_key,owner_id,expires_at)
  select a.tenant_id, claim_texttorrent_partition.partition_key, worker_id, now()+make_interval(secs=>lease_seconds)
  from sunbiz_agent_accounts a where a.id::text=split_part(partition_key,':',1)
  on conflict (tenant_id,partition_key) do update set owner_id=excluded.owner_id,
    acquired_at=now(), heartbeat_at=now(), expires_at=excluded.expires_at
  where sunbiz_processing_leases.expires_at < now() or sunbiz_processing_leases.owner_id=worker_id;
  get diagnostics changed = row_count;
  return changed > 0;
end $$;

create or replace function public.heartbeat_texttorrent_partition(partition_key text, worker_id text, lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  update sunbiz_processing_leases set heartbeat_at=now(), expires_at=now()+make_interval(secs=>lease_seconds)
  where sunbiz_processing_leases.partition_key=heartbeat_texttorrent_partition.partition_key
    and owner_id=worker_id and expires_at>now();
  get diagnostics changed = row_count; return changed > 0;
end $$;

create or replace function public.release_texttorrent_partition(partition_key text, worker_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  delete from sunbiz_processing_leases where sunbiz_processing_leases.partition_key=release_texttorrent_partition.partition_key
    and owner_id=worker_id;
  get diagnostics changed = row_count; return changed > 0;
end $$;

create or replace function public.claim_texttorrent_inbound(account_id uuid, worker_id text, lease_seconds integer default 60)
returns setof public.texttorrent_inbound_work language sql security definer set search_path=public as $$
  update texttorrent_inbound_work w set status='running', claimed_by=worker_id, claimed_at=now(),
    lease_expires_at=now()+make_interval(secs=>lease_seconds), attempts=attempts+1
  where w.id=(select id from texttorrent_inbound_work where agent_account_id=account_id
    and (status='pending' or (status='running' and lease_expires_at<now())) and available_at<=now()
    order by priority asc, created_at asc for update skip locked limit 1)
  returning w.*;
$$;

create or replace function public.consume_texttorrent_rate_token(bucket text, worker_id text, priority integer,
  "limit" integer default 60, window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare tid uuid; changed integer;
begin
  tid := split_part(bucket,':',1)::uuid;
  insert into sunbiz_provider_rate_state(tenant_id,provider,window_started_at,request_count)
  values(tid,'texttorrent',now(),1)
  on conflict(tenant_id,provider) do update set
    window_started_at=case when sunbiz_provider_rate_state.window_started_at < now()-make_interval(secs=>window_seconds)
      then now() else sunbiz_provider_rate_state.window_started_at end,
    request_count=case when sunbiz_provider_rate_state.window_started_at < now()-make_interval(secs=>window_seconds)
      then 1 else sunbiz_provider_rate_state.request_count+1 end, updated_at=now()
  where sunbiz_provider_rate_state.window_started_at < now()-make_interval(secs=>window_seconds)
    or sunbiz_provider_rate_state.request_count < "limit";
  get diagnostics changed = row_count; return changed > 0;
end $$;

create or replace function public.texttorrent_runtime_health(worker_id text)
returns jsonb language sql security definer set search_path=public as $$
  select jsonb_build_object('worker_id',worker_id,'now',now(),
    'active_leases',(select count(*) from sunbiz_processing_leases where owner_id=worker_id and expires_at>now()),
    'pending',(select count(*) from texttorrent_inbound_work where status='pending'),
    'running',(select count(*) from texttorrent_inbound_work where status='running'),
    'dead',(select count(*) from texttorrent_dead_letters where resolved_at is null));
$$;
revoke all on function public.claim_texttorrent_partition(text,text,integer),
 public.heartbeat_texttorrent_partition(text,text,integer), public.release_texttorrent_partition(text,text),
 public.claim_texttorrent_inbound(uuid,text,integer),
 public.consume_texttorrent_rate_token(text,text,integer,integer,integer),
 public.texttorrent_runtime_health(text) from public;
grant execute on function public.claim_texttorrent_partition(text,text,integer),
 public.heartbeat_texttorrent_partition(text,text,integer), public.release_texttorrent_partition(text,text),
 public.claim_texttorrent_inbound(uuid,text,integer),
 public.consume_texttorrent_rate_token(text,text,integer,integer,integer),
 public.texttorrent_runtime_health(text) to service_role;
