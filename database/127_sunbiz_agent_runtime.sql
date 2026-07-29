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
  bucket text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider='texttorrent'), window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count>=0), blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.sunbiz_phone_suppressions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_last10 text not null check (phone_last10 ~ '^[0-9]{10}$'),
  reason text not null, source text not null, source_work_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (tenant_id,phone_last10)
);
create table if not exists public.texttorrent_inbound_work (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.sunbiz_agent_accounts(id) on delete cascade,
  provider_message_id text not null, provider_conversation_id text,
  source_interaction_id uuid, inbound_message text not null,
  conversation jsonb not null default '{}'::jsonb,
  merchant_context jsonb not null default '{}'::jsonb,
  voice_profile jsonb not null default '{}'::jsonb,
  decision jsonb, priority integer not null default 100,
  status text not null default 'pending'
    check (status in ('pending','running','drafted','escalated','suppressed','dead_letter')),
  attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
  lease_owner text, claimed_at timestamptz, lease_expires_at timestamptz,
  last_error text, created_at timestamptz not null default now(), completed_at timestamptz,
  unique (tenant_id,provider_message_id)
);
create table if not exists public.texttorrent_dead_letters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  inbound_work_id uuid unique references public.texttorrent_inbound_work(id) on delete set null,
  account_id uuid not null references public.sunbiz_agent_accounts(id) on delete cascade,
  failure_code text not null, attempts integer not null,
  sanitized_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), resolved_at timestamptz
);
alter table public.inference_jobs add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.inference_jobs add column if not exists next_attempt_at timestamptz;
update public.inference_jobs set next_attempt_at=now() where next_attempt_at is null;
alter table public.inference_jobs alter column next_attempt_at set default now();
alter table public.inference_jobs alter column next_attempt_at set not null;
create index if not exists idx_inference_jobs_retry_due
  on public.inference_jobs(status,next_attempt_at,created_at);
alter table public.agent_voice_profiles add column if not exists approved boolean not null default false;
alter table public.agent_voice_profiles add column if not exists approved_at timestamptz;
alter table public.agent_voice_profiles add column if not exists approved_by uuid;
create index if not exists idx_sunbiz_drafts_queue on public.sunbiz_reply_drafts(tenant_id,status,created_at);
create index if not exists idx_sunbiz_state_agent on public.sunbiz_conversation_state(tenant_id,agent_account_id,updated_at desc);
create index if not exists idx_sunbiz_leases_expiry on public.sunbiz_processing_leases(expires_at);
create index if not exists idx_tt_inbound_due on public.texttorrent_inbound_work(status,priority,next_attempt_at);
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
alter table public.sunbiz_phone_suppressions enable row level security;
alter table public.sunbiz_phone_suppressions force row level security;
alter table public.texttorrent_inbound_work enable row level security;
alter table public.texttorrent_inbound_work force row level security;
alter table public.texttorrent_dead_letters enable row level security;
alter table public.texttorrent_dead_letters force row level security;
revoke all on public.sunbiz_agent_accounts, public.sunbiz_conversation_state, public.sunbiz_reply_drafts,
  public.sunbiz_processing_leases, public.sunbiz_provider_rate_state from anon, authenticated;
revoke all on public.sunbiz_phone_suppressions from anon, authenticated;
revoke all on public.texttorrent_inbound_work, public.texttorrent_dead_letters from anon, authenticated;
drop policy if exists sunbiz_accounts_service_role on public.sunbiz_agent_accounts;
drop policy if exists sunbiz_state_service_role on public.sunbiz_conversation_state;
drop policy if exists sunbiz_drafts_service_role on public.sunbiz_reply_drafts;
drop policy if exists sunbiz_leases_service_role on public.sunbiz_processing_leases;
drop policy if exists sunbiz_rate_service_role on public.sunbiz_provider_rate_state;
drop policy if exists sunbiz_phone_suppressions_service_role on public.sunbiz_phone_suppressions;
drop policy if exists tt_inbound_work_service_role on public.texttorrent_inbound_work;
drop policy if exists tt_dead_letters_service_role on public.texttorrent_dead_letters;
create policy sunbiz_accounts_service_role on public.sunbiz_agent_accounts for all to service_role using(true) with check(true);
create policy sunbiz_state_service_role on public.sunbiz_conversation_state for all to service_role using(true) with check(true);
create policy sunbiz_drafts_service_role on public.sunbiz_reply_drafts for all to service_role using(true) with check(true);
create policy sunbiz_leases_service_role on public.sunbiz_processing_leases for all to service_role using(true) with check(true);
create policy sunbiz_rate_service_role on public.sunbiz_provider_rate_state for all to service_role using(true) with check(true);
create policy sunbiz_phone_suppressions_service_role on public.sunbiz_phone_suppressions for all to service_role using(true) with check(true);
create policy tt_inbound_work_service_role on public.texttorrent_inbound_work for all to service_role using(true) with check(true);
create policy tt_dead_letters_service_role on public.texttorrent_dead_letters for all to service_role using(true) with check(true);

create or replace function public.claim_texttorrent_partition(p_partition_key text, p_worker_id text, p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  insert into sunbiz_processing_leases(tenant_id,partition_key,owner_id,expires_at)
  select a.tenant_id, p_partition_key, p_worker_id, now()+make_interval(secs=>p_lease_seconds)
  from sunbiz_agent_accounts a where a.id::text=split_part(p_partition_key,':',1)
  on conflict (tenant_id,partition_key) do update set owner_id=excluded.owner_id,
    acquired_at=now(), heartbeat_at=now(), expires_at=excluded.expires_at
  where sunbiz_processing_leases.expires_at < now() or sunbiz_processing_leases.owner_id=p_worker_id;
  get diagnostics changed = row_count;
  return changed > 0;
end $$;

create or replace function public.heartbeat_texttorrent_partition(p_partition_key text, p_worker_id text, p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  update sunbiz_processing_leases set heartbeat_at=now(), expires_at=now()+make_interval(secs=>p_lease_seconds)
  where sunbiz_processing_leases.partition_key=p_partition_key
    and owner_id=p_worker_id and expires_at>now();
  get diagnostics changed = row_count; return changed > 0;
end $$;

create or replace function public.release_texttorrent_partition(p_partition_key text, p_worker_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  delete from sunbiz_processing_leases where sunbiz_processing_leases.partition_key=p_partition_key
    and owner_id=p_worker_id;
  get diagnostics changed = row_count; return changed > 0;
end $$;

create or replace function public.claim_texttorrent_inbound(p_account_id uuid, p_worker_id text, p_lease_seconds integer default 60)
returns setof public.texttorrent_inbound_work language sql security definer set search_path=public as $$
  update texttorrent_inbound_work w set status='running', lease_owner=p_worker_id, claimed_at=now(),
    lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
  where w.id=(select id from texttorrent_inbound_work where account_id=p_account_id
    and (status='pending' or (status='running' and lease_expires_at<now())) and next_attempt_at<=now()
    order by priority asc, created_at asc for update skip locked limit 1)
  returning w.*;
$$;

create or replace function public.consume_texttorrent_rate_token(p_bucket text, p_worker_id text, p_priority integer,
  p_limit integer default 60, p_window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare tid uuid; changed integer; effective_limit integer;
begin
  -- Bucket format is <tenant_uuid>:parent-sid. Every account, runtime worker,
  -- poller and approved-reply dispatcher sharing that parent credential MUST
  -- consume this same tenant bucket.
  if p_bucket !~ '^[0-9a-fA-F-]{36}:parent-sid$' then return false; end if;
  tid := split_part(p_bucket,':',1)::uuid;
  -- Reserve capacity for urgent work instead of allowing analytics/backfills
  -- to consume the entire parent-SID window. Priority 90+ (compliance) may
  -- use all tokens; approved replies retain five; normal inbound retains ten;
  -- low-priority analytics/backfills retain twenty for higher-priority work.
  effective_limit := greatest(1, least(p_limit, case
    when p_priority >= 90 then p_limit
    when p_priority >= 80 then p_limit - 5
    when p_priority >= 50 then p_limit - 10
    else p_limit - 20
  end));
  insert into sunbiz_provider_rate_state(bucket,tenant_id,provider,window_started_at,request_count)
  values(p_bucket,tid,'texttorrent',now(),1)
  on conflict(bucket) do update set
    window_started_at=case when sunbiz_provider_rate_state.window_started_at < now()-make_interval(secs=>p_window_seconds)
      then now() else sunbiz_provider_rate_state.window_started_at end,
    request_count=case when sunbiz_provider_rate_state.window_started_at < now()-make_interval(secs=>p_window_seconds)
      then 1 else sunbiz_provider_rate_state.request_count+1 end, updated_at=now()
  where sunbiz_provider_rate_state.window_started_at < now()-make_interval(secs=>p_window_seconds)
    or sunbiz_provider_rate_state.request_count < effective_limit;
  get diagnostics changed = row_count; return changed > 0;
end $$;

create or replace function public.suppress_texttorrent_inbound(
  p_inbound_work_id uuid, p_tenant_id uuid, p_account_id uuid, p_reason text, p_worker_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare w texttorrent_inbound_work; state_id uuid;
begin
  select * into w from texttorrent_inbound_work where id=p_inbound_work_id
    and tenant_id=p_tenant_id and account_id=p_account_id and status='running'
    and lease_owner=p_worker_id for update;
  if not found then return false; end if;
  if length(regexp_replace(coalesce(w.conversation->>'to_phone',''),'\D','','g')) < 10 then return false; end if;
  insert into sunbiz_phone_suppressions(tenant_id,phone_last10,reason,source,source_work_id,updated_at)
  values(w.tenant_id,right(regexp_replace(w.conversation->>'to_phone','\D','','g'),10),
    p_reason,'texttorrent_runtime',w.id,now())
  on conflict(tenant_id,phone_last10) do update set reason=excluded.reason,source=excluded.source,
    source_work_id=excluded.source_work_id,updated_at=now();
  insert into sunbiz_conversation_state(tenant_id,provider,provider_conversation_id,lead_id,
    agent_account_id,qualification_state,last_intent,last_action,automation_paused,knowledge_version)
  select w.tenant_id,'texttorrent',coalesce(w.provider_conversation_id,w.provider_message_id),
    nullif(w.conversation->>'lead_id','')::uuid,w.account_id,'{}',p_reason,'suppressed',true,a.knowledge_version
  from sunbiz_agent_accounts a where a.id=w.account_id
  on conflict(tenant_id,provider,provider_conversation_id) do update set
    last_intent=excluded.last_intent,last_action='suppressed',automation_paused=true,updated_at=now()
  returning id into state_id;
  update scheduled_sends set status='cancelled'
    where tenant_id=w.tenant_id and channel='sms' and status='pending'
      and (thread_key=w.conversation->>'thread_key' or to_phone=w.conversation->>'to_phone');
  update texttorrent_inbound_work set status='suppressed',
    decision=jsonb_build_object('intent',p_reason,'shouldSuppress',true),
    lease_owner=null,lease_expires_at=null,completed_at=now(),last_error=null where id=w.id;
  return true;
end $$;

create or replace function public.finalize_texttorrent_inbound(
  p_work_id uuid, p_worker_id text, p_status text, p_decision jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare w texttorrent_inbound_work; a sunbiz_agent_accounts; state_id uuid; response text;
begin
  if p_status not in ('drafted','escalated') then return false; end if;
  select * into w from texttorrent_inbound_work where id=p_work_id and status='running'
    and lease_owner=p_worker_id for update;
  if not found then return false; end if;
  select * into a from sunbiz_agent_accounts where id=w.account_id and tenant_id=w.tenant_id;
  if not found then return false; end if;
  insert into sunbiz_conversation_state(tenant_id,provider,provider_conversation_id,lead_id,
    agent_account_id,qualification_state,last_intent,last_action,automation_paused,
    human_owner_id,knowledge_version,updated_at)
  values(w.tenant_id,'texttorrent',coalesce(w.provider_conversation_id,w.provider_message_id),
    nullif(w.conversation->>'lead_id','')::uuid,w.account_id,
    coalesce(p_decision->'qualification_updates','{}'::jsonb),p_decision->>'intent',p_status,
    false,case when p_status='escalated' then a.handoff_user_id else null end,a.knowledge_version,now())
  on conflict(tenant_id,provider,provider_conversation_id) do update set
    qualification_state=sunbiz_conversation_state.qualification_state || excluded.qualification_state,last_intent=excluded.last_intent,
    last_action=excluded.last_action,human_owner_id=coalesce(excluded.human_owner_id,sunbiz_conversation_state.human_owner_id),
    knowledge_version=excluded.knowledge_version,updated_at=now()
  returning id into state_id;
  response := nullif(btrim(p_decision->>'response'),'');
  if p_status='drafted' and response is not null then
    insert into sunbiz_reply_drafts(tenant_id,conversation_state_id,agent_account_id,lead_id,
      thread_key,to_phone,original_text,intent,confidence,model_id,model_version,
      knowledge_version,source_interaction_id,provider_message_id)
    values(w.tenant_id,state_id,w.account_id,nullif(w.conversation->>'lead_id','')::uuid,
      w.conversation->>'thread_key',w.conversation->>'to_phone',left(response,1600),
      coalesce(p_decision->>'intent','UNCERTAIN'),nullif(p_decision->>'confidence','')::numeric,
      p_decision->>'model_id',p_decision->>'model_version',a.knowledge_version,
      w.source_interaction_id,w.provider_message_id)
    on conflict(tenant_id,source_interaction_id) do nothing;
  elsif p_status='drafted' then
    return false;
  end if;
  update texttorrent_inbound_work set status=p_status,decision=p_decision,lease_owner=null,
    lease_expires_at=null,completed_at=now(),last_error=null where id=w.id;
  insert into agent_events(event_type,publisher_agent,severity,payload,correlation_id)
  values(case when p_status='drafted' then 'TEXTTORRENT_DRAFT_READY' else 'TEXTTORRENT_HANDOFF_REQUIRED' end,
    'texttorrent-runtime',case when p_status='drafted' then 'info' else 'warn' end,
    jsonb_build_object('tenant_id',w.tenant_id,'account_id',w.account_id,'work_id',w.id,
      'conversation_state_id',state_id,'intent',p_decision->>'intent'),w.tenant_id::text);
  return true;
end $$;

create or replace function public.approve_sunbiz_draft(
  p_draft_id uuid, p_tenant_id uuid, p_user_id uuid, p_final_text text)
returns uuid language plpgsql security definer set search_path=public as $$
declare d sunbiz_reply_drafts; a sunbiz_agent_accounts; send_id uuid; phone10 text;
begin
  select * into d from sunbiz_reply_drafts where id=p_draft_id and tenant_id=p_tenant_id
    and status='pending' for update;
  if not found or char_length(btrim(p_final_text)) not between 1 and 1600 then return null; end if;
  select * into a from sunbiz_agent_accounts where id=d.agent_account_id and tenant_id=p_tenant_id
    and enabled=true and mode='semi' for update;
  if not found or (a.user_id<>p_user_id and not exists(select 1 from user_profiles
    where tenant_id=p_tenant_id and auth_user_id=p_user_id and (is_owner=true or team_role in ('owner','admin'))))
    then return null; end if;
  phone10 := right(regexp_replace(d.to_phone,'\D','','g'),10);
  if exists(select 1 from sunbiz_phone_suppressions where tenant_id=p_tenant_id and phone_last10=phone10)
    then return null; end if;
  if exists(select 1 from lead_interactions newer join lead_interactions source on source.id=d.source_interaction_id
    where newer.tenant_id=p_tenant_id and newer.direction='inbound'
      and (newer.lead_id=d.lead_id or right(regexp_replace(newer.from_phone,'\D','','g'),10)=phone10)
      and coalesce(newer.sent_at,newer.created_at)>coalesce(source.sent_at,source.created_at))
    then return null; end if;
  if (select count(*) from scheduled_sends where tenant_id=p_tenant_id and actor_user_id=a.user_id
      and channel='sms' and status in ('pending','sending','sent') and created_at>=date_trunc('day',now())) >= a.daily_cap
    then return null; end if;
  insert into scheduled_sends(tenant_id,lead_id,thread_key,channel,to_phone,body,actor_user_id,
    from_identity,scheduled_for,status)
  values(p_tenant_id,d.lead_id,d.thread_key,'sms',d.to_phone,btrim(p_final_text),a.user_id,
    a.from_number,now(),'pending') returning id into send_id;
  update sunbiz_reply_drafts set status='approved',final_text=btrim(p_final_text),approved_by=p_user_id,
    approved_at=now(),scheduled_send_id=send_id,updated_at=now() where id=d.id;
  return send_id;
end $$;

create or replace function public.fail_texttorrent_inbound(
  p_work_id uuid, p_worker_id text, p_error_code text, p_max_attempts integer,
  p_next_attempt_at timestamptz)
returns text language plpgsql security definer set search_path=public as $$
declare w texttorrent_inbound_work; next_attempts integer; next_status text;
begin
  if p_max_attempts < 1 or p_error_code is null or p_error_code = '' then return null; end if;
  select * into w from texttorrent_inbound_work where id=p_work_id and status='running'
    and lease_owner=p_worker_id for update;
  if not found then return null; end if;
  next_attempts := w.attempts + 1;
  next_status := case when next_attempts >= p_max_attempts then 'dead_letter' else 'pending' end;
  if next_status='dead_letter' then
    insert into texttorrent_dead_letters(inbound_work_id,tenant_id,account_id,failure_code,attempts,sanitized_metadata)
    values(w.id,w.tenant_id,w.account_id,left(p_error_code,120),next_attempts,
      jsonb_build_object('provider_message_id',w.provider_message_id))
    on conflict do nothing;
  end if;
  update texttorrent_inbound_work set status=next_status,attempts=next_attempts,
    next_attempt_at=case when next_status='pending' then coalesce(p_next_attempt_at,now()) else next_attempt_at end,
    lease_owner=null,lease_expires_at=null,last_error=left(p_error_code,120),
    completed_at=case when next_status='dead_letter' then now() else null end
  where id=w.id;
  return next_status;
end $$;

create or replace function public.texttorrent_runtime_health(p_worker_id text)
returns jsonb language sql security definer set search_path=public as $$
  select jsonb_build_object('worker_id',p_worker_id,'now',now(),
    'active_leases',(select count(*) from sunbiz_processing_leases where owner_id=p_worker_id and expires_at>now()),
    'pending',(select count(*) from texttorrent_inbound_work where status='pending'),
    'running',(select count(*) from texttorrent_inbound_work where status='running'),
    'dead',(select count(*) from texttorrent_dead_letters where resolved_at is null),
    'oldest_pending_at',(select min(created_at) from texttorrent_inbound_work where status='pending'));
$$;
revoke all on function public.claim_texttorrent_partition(text,text,integer),
 public.heartbeat_texttorrent_partition(text,text,integer), public.release_texttorrent_partition(text,text),
 public.claim_texttorrent_inbound(uuid,text,integer),
 public.consume_texttorrent_rate_token(text,text,integer,integer,integer),
 public.suppress_texttorrent_inbound(uuid,uuid,uuid,text,text),
 public.finalize_texttorrent_inbound(uuid,text,text,jsonb),
 public.approve_sunbiz_draft(uuid,uuid,uuid,text),
 public.fail_texttorrent_inbound(uuid,text,text,integer,timestamptz),
 public.texttorrent_runtime_health(text) from public;
grant execute on function public.claim_texttorrent_partition(text,text,integer),
 public.heartbeat_texttorrent_partition(text,text,integer), public.release_texttorrent_partition(text,text),
 public.claim_texttorrent_inbound(uuid,text,integer),
 public.consume_texttorrent_rate_token(text,text,integer,integer,integer),
 public.suppress_texttorrent_inbound(uuid,uuid,uuid,text,text),
 public.finalize_texttorrent_inbound(uuid,text,text,jsonb),
 public.approve_sunbiz_draft(uuid,uuid,uuid,text),
 public.fail_texttorrent_inbound(uuid,text,text,integer,timestamptz),
 public.texttorrent_runtime_health(text) to service_role;
