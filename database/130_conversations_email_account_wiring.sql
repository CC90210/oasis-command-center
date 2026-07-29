-- Reuse the tenant's encrypted Google Workspace IMAP credentials for the
-- tenant owner so the shared SunBiz mailbox participates in Conversations.
-- Ciphertext is copied, never decrypted or exposed.

insert into public.user_integration_credentials (
  tenant_id, user_id, service, field_key, encrypted_value, created_at, updated_at
)
select
  c.tenant_id,
  p.auth_user_id,
  'gmail_imap',
  case c.field_key when 'from_address' then 'address' else 'app_password' end,
  c.encrypted_value,
  now(),
  now()
from public.tenant_integration_credentials c
join public.user_profiles p
  on p.tenant_id = c.tenant_id and p.is_owner = true and p.auth_user_id is not null
where c.service = 'gws'
  and c.field_key in ('from_address', 'app_password')
on conflict (tenant_id, user_id, service, field_key)
do nothing;

insert into public.agent_email_settings (
  tenant_id, user_id, mode, work_enabled, personal_enabled, detail
)
select distinct
  u.tenant_id, u.user_id, 'monitor', true, false,
  jsonb_build_object('provisioned_from', 'tenant_gws')
from public.user_integration_credentials u
where u.service = 'gmail_imap'
  and u.field_key = 'address'
on conflict (tenant_id, user_id)
do update set
  work_enabled = true,
  updated_at = now();
