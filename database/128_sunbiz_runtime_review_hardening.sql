-- 128_sunbiz_runtime_review_hardening.sql
-- Apply AFTER 127. 127 is already production history; all review fixes are
-- additive/replacements here. Tenant-explicit lease RPCs are the new contract.

create index if not exists idx_tt_inbound_account_due
  on public.texttorrent_inbound_work(account_id,status,next_attempt_at,priority,created_at);

create or replace function public.heartbeat_texttorrent_partition(
  p_tenant_id uuid,p_partition_key text,p_worker_id text,p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  update sunbiz_processing_leases set heartbeat_at=now(),
    expires_at=now()+make_interval(secs=>p_lease_seconds)
  where tenant_id=p_tenant_id and partition_key=p_partition_key
    and owner_id=p_worker_id and expires_at>now();
  get diagnostics changed=row_count; return changed>0;
end $$;

create or replace function public.release_texttorrent_partition(
  p_tenant_id uuid,p_partition_key text,p_worker_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  delete from sunbiz_processing_leases where tenant_id=p_tenant_id
    and partition_key=p_partition_key and owner_id=p_worker_id;
  get diagnostics changed=row_count; return changed>0;
end $$;

-- Secure legacy overloads during the rolling runtime deployment by deriving
-- tenant from the account UUID prefix. Remove these after every caller uses the
-- tenant-explicit signatures above.
create or replace function public.heartbeat_texttorrent_partition(
  p_partition_key text,p_worker_id text,p_lease_seconds integer default 60)
returns boolean language sql security definer set search_path=public as $$
  select public.heartbeat_texttorrent_partition(
    (select tenant_id from sunbiz_agent_accounts where id::text=split_part(p_partition_key,':',1)),
    p_partition_key,p_worker_id,p_lease_seconds);
$$;
create or replace function public.release_texttorrent_partition(p_partition_key text,p_worker_id text)
returns boolean language sql security definer set search_path=public as $$
  select public.release_texttorrent_partition(
    (select tenant_id from sunbiz_agent_accounts where id::text=split_part(p_partition_key,':',1)),
    p_partition_key,p_worker_id);
$$;

create or replace function public.suppress_texttorrent_inbound(
  p_inbound_work_id uuid,p_tenant_id uuid,p_account_id uuid,p_reason text,p_worker_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare w texttorrent_inbound_work; state_id uuid; phone10 text;
begin
  select * into w from texttorrent_inbound_work where id=p_inbound_work_id
    and tenant_id=p_tenant_id and account_id=p_account_id and status='running'
    and lease_owner=p_worker_id for update;
  if not found then return false; end if;
  phone10:=right(regexp_replace(coalesce(w.conversation->>'to_phone',''),'\D','','g'),10);
  if length(phone10)<>10 then return false; end if;
  insert into sunbiz_phone_suppressions(tenant_id,phone_last10,reason,source,source_work_id,updated_at)
  values(w.tenant_id,phone10,p_reason,'texttorrent_runtime',w.id,now())
  on conflict(tenant_id,phone_last10) do update set reason=excluded.reason,
    source=excluded.source,source_work_id=excluded.source_work_id,updated_at=now();
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
    and (thread_key=w.conversation->>'thread_key'
      or right(regexp_replace(coalesce(to_phone,''),'\D','','g'),10)=phone10);
  update texttorrent_inbound_work set status='suppressed',
    decision=jsonb_build_object('intent',p_reason,'shouldSuppress',true),
    lease_owner=null,lease_expires_at=null,completed_at=now(),last_error=null where id=w.id;
  return true;
end $$;

create or replace function public.approve_sunbiz_draft(
  p_draft_id uuid,p_tenant_id uuid,p_user_id uuid,p_final_text text)
returns uuid language plpgsql security definer set search_path=public as $$
declare d sunbiz_reply_drafts;a sunbiz_agent_accounts;send_id uuid;phone10 text;
begin
  if p_final_text is null or char_length(btrim(p_final_text)) not between 1 and 1600 then return null; end if;
  select * into d from sunbiz_reply_drafts where id=p_draft_id and tenant_id=p_tenant_id
    and status='pending' for update;
  if not found then return null; end if;
  select * into a from sunbiz_agent_accounts where id=d.agent_account_id and tenant_id=p_tenant_id
    and enabled=true and mode='semi' for update;
  if not found or (a.user_id<>p_user_id and not exists(select 1 from user_profiles
    where tenant_id=p_tenant_id and auth_user_id=p_user_id and (is_owner=true or team_role in ('owner','admin'))))
    then return null; end if;
  phone10:=right(regexp_replace(d.to_phone,'\D','','g'),10);
  if exists(select 1 from sunbiz_phone_suppressions where tenant_id=p_tenant_id and phone_last10=phone10)
    then return null; end if;
  if exists(select 1 from lead_interactions newer join lead_interactions source on source.id=d.source_interaction_id
    where newer.tenant_id=p_tenant_id and newer.direction='inbound'
      and (newer.lead_id=d.lead_id or right(regexp_replace(newer.from_phone,'\D','','g'),10)=phone10)
      and coalesce(newer.sent_at,newer.created_at)>coalesce(source.sent_at,source.created_at))
    then return null; end if;
  if (select count(*) from scheduled_sends where tenant_id=p_tenant_id and actor_user_id=a.user_id
    and channel='sms' and status in ('pending','sending','sent') and created_at>=date_trunc('day',now()))>=a.daily_cap
    then return null; end if;
  insert into scheduled_sends(tenant_id,lead_id,thread_key,channel,to_phone,body,actor_user_id,
    from_identity,scheduled_for,status)
  values(p_tenant_id,d.lead_id,d.thread_key,'sms',d.to_phone,btrim(p_final_text),a.user_id,
    a.from_number,now(),'pending') returning id into send_id;
  update sunbiz_reply_drafts set status='approved',final_text=btrim(p_final_text),approved_by=p_user_id,
    approved_at=now(),scheduled_send_id=send_id,updated_at=now() where id=d.id;
  return send_id;
end $$;

revoke all on function public.heartbeat_texttorrent_partition(uuid,text,text,integer),
  public.release_texttorrent_partition(uuid,text,text) from public;
grant execute on function public.heartbeat_texttorrent_partition(uuid,text,text,integer),
  public.release_texttorrent_partition(uuid,text,text) to service_role;
