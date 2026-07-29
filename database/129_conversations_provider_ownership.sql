-- Conversations provider ownership and Mine/Unassigned/All activation.
-- Safe to re-run. No credentials are stored here.

create or replace function public.conv_interaction_thread_key(p public.lead_interactions)
returns text language sql immutable as $$
  select case
    when p.lead_id is not null then 'lead:' || p.lead_id::text
    when public.conv_normalize_phone(
      case when p.direction = 'inbound' then coalesce(p.from_phone, p.to_phone)
           else coalesce(p.to_phone, p.from_phone) end
    ) is not null then 'phone:' || public.conv_normalize_phone(
      case when p.direction = 'inbound' then coalesce(p.from_phone, p.to_phone)
           else coalesce(p.to_phone, p.from_phone) end
    )
    when nullif(lower(case when p.direction = 'inbound'
      then coalesce(p.from_email, p.metadata->>'from_email', p.to_email)
      else coalesce(p.to_email, p.from_email, p.metadata->>'from_email') end), '') is not null
      then 'email:' || lower(case when p.direction = 'inbound'
        then coalesce(p.from_email, p.metadata->>'from_email', p.to_email)
        else coalesce(p.to_email, p.from_email, p.metadata->>'from_email') end)
    else 'id:' || p.id::text
  end
$$;

create or replace function public.conv_resolve_interaction_owner(p public.lead_interactions)
returns text language plpgsql stable as $$
declare
  v_owner text;
  v_business_phone text;
  v_business_email text;
begin
  if p.lead_id is not null then
    select nullif(r.data->>'assigned_to', '') into v_owner
    from public.tenant_records r
    where r.tenant_id = p.tenant_id and r.id = p.lead_id
      and (r.data->>'assigned_to') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    limit 1;
  end if;
  if v_owner is null and p.actor_user_id is not null then
    select u.auth_user_id::text into v_owner
    from public.user_profiles u
    where u.tenant_id = p.tenant_id and u.auth_user_id = p.actor_user_id
    limit 1;
  end if;
  v_business_phone := public.conv_normalize_phone(
    case when p.direction = 'inbound' then p.to_phone else p.from_phone end
  );
  v_business_email := nullif(lower(
    case when p.direction = 'inbound' then p.to_email
         else coalesce(p.from_email, p.metadata->>'from_email') end
  ), '');
  if v_owner is null and v_business_phone is not null then
    select c.owner_user_id::text into v_owner
    from public.channel_accounts c
    where c.tenant_id = p.tenant_id and c.is_active
      and public.conv_normalize_phone(c.from_phone) = v_business_phone
    limit 1;
  end if;
  if v_owner is null and v_business_phone is not null then
    select a.user_id::text into v_owner
    from public.sunbiz_agent_accounts a
    where a.tenant_id = p.tenant_id and a.enabled
      and public.conv_normalize_phone(a.from_number) = v_business_phone
    limit 1;
  end if;
  if v_owner is null and v_business_email is not null then
    select c.owner_user_id::text into v_owner
    from public.channel_accounts c
    where c.tenant_id = p.tenant_id and c.is_active
      and lower(c.from_email) = v_business_email
    limit 1;
  end if;
  return v_owner;
end
$$;

create or replace function public.conv_thread_set_owner()
returns trigger language plpgsql as $$
declare
  v_owner text;
begin
  v_owner := public.conv_resolve_interaction_owner(NEW);
  if v_owner is not null then
    update public.conversation_threads
    set owner_agent_id = v_owner,
        assigned_to = coalesce(assigned_to, v_owner),
        updated_at = now()
    where tenant_id = NEW.tenant_id
      and thread_key = public.conv_interaction_thread_key(NEW);
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_zz_conv_thread_set_owner on public.lead_interactions;
create trigger trg_zz_conv_thread_set_owner
after insert on public.lead_interactions
for each row execute function public.conv_thread_set_owner();

create or replace function public.conv_sync_lead_assignment()
returns trigger language plpgsql as $$
declare
  v_owner text;
begin
  v_owner := nullif(NEW.data->>'assigned_to', '');
  if v_owner is distinct from nullif(OLD.data->>'assigned_to', '')
     and v_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.conversation_threads
    set owner_agent_id = v_owner, assigned_to = v_owner, updated_at = now()
    where tenant_id = NEW.tenant_id and lead_id = NEW.id;
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_conv_sync_lead_assignment on public.tenant_records;
create trigger trg_conv_sync_lead_assignment
after update of data on public.tenant_records
for each row execute function public.conv_sync_lead_assignment();

update public.conversation_threads t
set owner_agent_id = r.data->>'assigned_to',
    assigned_to = coalesce(t.assigned_to, r.data->>'assigned_to'),
    updated_at = now()
from public.tenant_records r
where r.tenant_id = t.tenant_id and r.id = t.lead_id
  and (r.data->>'assigned_to') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

insert into public.channel_accounts (
  tenant_id, provider, owner_user_id, display_name, from_email, from_phone,
  credential_ref, is_active
)
select a.tenant_id, a.provider, a.user_id, a.display_name, a.act_as_email,
       a.from_number, 'sunbiz_agent_accounts:' || a.id::text, a.enabled
from public.sunbiz_agent_accounts a
where a.provider = 'texttorrent'
on conflict (tenant_id, provider, from_phone) where from_phone is not null
do update set owner_user_id = excluded.owner_user_id,
              display_name = excluded.display_name,
              from_email = excluded.from_email,
              credential_ref = excluded.credential_ref,
              is_active = excluded.is_active,
              updated_at = now();

revoke execute on function public.conv_interaction_thread_key(public.lead_interactions) from public, anon, authenticated;
revoke execute on function public.conv_resolve_interaction_owner(public.lead_interactions) from public, anon, authenticated;
revoke execute on function public.conv_thread_set_owner() from public, anon, authenticated;
revoke execute on function public.conv_sync_lead_assignment() from public, anon, authenticated;
grant execute on function public.conv_interaction_thread_key(public.lead_interactions) to service_role;
grant execute on function public.conv_resolve_interaction_owner(public.lead_interactions) to service_role;
grant execute on function public.conv_thread_set_owner() to service_role;
grant execute on function public.conv_sync_lead_assignment() to service_role;
