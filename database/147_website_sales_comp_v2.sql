-- 147 — website sales comp v2: opener 20% / opener-closer 30%.
--
-- REPLACES the 10/12.5/15% deal-size tiers baked into close_website_deal() by
-- migration 146 (operator-approved 2026-08-19). Rate now keys on WHO CLOSED,
-- not on deal size:
--   * rep opened, founder closed              -> 20% of collected setup
--   * rep opened AND closed it themselves     -> 30% of collected setup
--   * $2,000 setup floor unchanged; setup revenue only, no recurring share.
-- Commission is ALWAYS inserted as 'accrued' — rep-closed deals never
-- auto-approve; founder approval still gates payout (accrued->approved->paid).
--
-- Companion files: database/turso/147_website_sales_engine.turso.sql (tables
-- for the Turso backend, where 146 was never applied) and the TS port of this
-- function in lib/turso-rpc-shim.ts (close_website_deal). Keep all three in
-- lockstep.

begin;

-- Who actually closed the deal (rep => 30% path, founder => 20% path).
-- 146 had no such column; deals closed under 146 keep NULL here.
alter table public.website_deals add column if not exists closed_by uuid;

-- CREATE OR REPLACE with an ADDED parameter would create an OVERLOAD: the old
-- 10-arg tiered function would stay live, and a PostgREST rpc() call omitting
-- p_closed_by_rep would still resolve to it. Drop the 146 signature first so
-- exactly one close_website_deal exists.
drop function if exists public.close_website_deal(uuid, uuid, uuid, uuid, text, text[], text, numeric, numeric, text);

create or replace function public.close_website_deal(
  p_tenant_id uuid, p_lead_id uuid, p_rep_user_id uuid, p_founder_user_id uuid, p_package_id text,
  p_automation_ids text[], p_currency text, p_setup_amount numeric, p_monthly_amount numeric, p_payment_reference text,
  p_closed_by_rep boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_deal website_deals; v_rate numeric; v_commission website_sales_commissions; v_lead_data jsonb; v_frozen_rep text; v_closed_by uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select data into v_lead_data from tenant_records where id=p_lead_id and tenant_id=p_tenant_id and entity_type='lead' for update;
  if v_lead_data is null then raise exception 'lead_not_found_or_wrong_tenant' using errcode='02000'; end if;
  -- Closer guard, adapted from 146: the owner/admin check applies to the CLOSER.
  -- Founder path (p_closed_by_rep=false): p_founder_user_id must be owner/admin.
  -- Rep path (p_closed_by_rep=true): the closer IS the rep; authorization comes
  -- from the rep guards below (team_role='agent' + frozen attribution match).
  if not p_closed_by_rep then
    if not exists (select 1 from user_profiles where tenant_id=p_tenant_id and auth_user_id=p_founder_user_id and (is_owner=true or team_role in ('owner','admin'))) then raise exception 'founder_not_authorized_for_tenant' using errcode='42501'; end if;
  end if;
  if not exists (select 1 from user_profiles where tenant_id=p_tenant_id and auth_user_id=p_rep_user_id and team_role='agent') then raise exception 'rep_not_agent_for_tenant' using errcode='42501'; end if;
  v_frozen_rep := coalesce(v_lead_data->>'attributed_rep_user_id', v_lead_data->>'assigned_to');
  if v_frozen_rep is null or v_frozen_rep <> p_rep_user_id::text then raise exception 'rep_does_not_match_frozen_attribution' using errcode='42501'; end if;
  if p_setup_amount < 2000 then raise exception 'collected setup below commission floor' using errcode='22023'; end if;
  v_closed_by := case when p_closed_by_rep then p_rep_user_id else p_founder_user_id end;
  v_rate := case when v_closed_by = p_rep_user_id then .30 else .20 end;
  select * into v_deal from website_deals where tenant_id=p_tenant_id and lead_id=p_lead_id for update;
  if v_deal.id is not null then
    -- Idempotent re-close: identical replay returns the existing deal; any drift
    -- (including a different closer — the rate would differ) is a hard error.
    -- Deals closed under 146 have closed_by NULL, so IS DISTINCT FROM makes any
    -- re-close of a pre-147 deal a mismatch — deliberate: never silently re-rate.
    if v_deal.status <> 'won' or v_deal.rep_user_id <> p_rep_user_id or v_deal.founder_user_id <> p_founder_user_id or v_deal.package_id <> p_package_id or v_deal.automation_ids <> coalesce(p_automation_ids,'{}') or v_deal.currency <> p_currency or v_deal.setup_amount <> p_setup_amount or v_deal.monthly_amount <> p_monthly_amount or v_deal.payment_reference <> p_payment_reference or v_deal.closed_by is distinct from v_closed_by then raise exception 'deal_already_closed_mismatch' using errcode='23505'; end if;
  else
    insert into website_deals (tenant_id,lead_id,rep_user_id,founder_user_id,package_id,automation_ids,currency,setup_amount,monthly_amount,proposal_status,status,payment_reference,closed_at,closed_by)
    values (p_tenant_id,p_lead_id,p_rep_user_id,p_founder_user_id,p_package_id,coalesce(p_automation_ids,'{}'),p_currency,p_setup_amount,p_monthly_amount,'accepted','won',p_payment_reference,now(),v_closed_by) returning * into v_deal;
  end if;
  insert into website_sales_commissions (tenant_id,deal_id,rep_user_id,payment_reference,collected_setup_amount,rate,amount)
  values (p_tenant_id,v_deal.id,v_deal.rep_user_id,p_payment_reference,p_setup_amount,v_rate,round(p_setup_amount*v_rate,2))
  on conflict (tenant_id,payment_reference,entry_type) do update set updated_at=website_sales_commissions.updated_at where website_sales_commissions.deal_id = excluded.deal_id returning * into v_commission;
  if v_commission.id is null then raise exception 'payment_reference_already_used_by_another_deal' using errcode='23505'; end if;
  insert into website_onboarding (tenant_id,deal_id,lead_id) values (p_tenant_id,v_deal.id,p_lead_id) on conflict (tenant_id,deal_id) do nothing;
  perform patch_tenant_record_data(p_lead_id,p_tenant_id,jsonb_build_object('stage','onboarding','stage_entered_at',now(),'closed_by',v_closed_by,'collected_setup_amount',p_setup_amount,'quoted_monthly_amount',p_monthly_amount));
  return jsonb_build_object('deal_id',v_deal.id,'commission_id',v_commission.id,'commission_amount',v_commission.amount);
end $$;

commit;
