-- 110_admin_access_toggle.sql
-- Per-agent admin-access toggle + a critical profile-grant hardening fix.
-- APPLIED to the live Bravo project (phctllmtsogkovoilwos) on 2026-07-07 via the
-- Supabase Management API; this file is the repo record. Idempotent + safe to re-run.

-- 1) The toggle flag + audit columns. `admin_access` is an ORTHOGONAL grant on top
--    of the base team_role: an admin can flip an agent to full admin and back.
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS admin_access boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS admin_access_granted_by uuid;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS admin_access_granted_at timestamptz;

-- 2) SECURITY (critical, platform-wide). user_profiles had a TABLE-LEVEL `GRANT
--    UPDATE` to `authenticated` (all columns) + a self-row RLS UPDATE policy
--    (profile_self_update: auth_user_id = auth.uid()) + no guard trigger. So ANY
--    logged-in user could, with the public anon key + their own JWT, do
--        PATCH /rest/v1/user_profiles?auth_user_id=eq.<self> { "is_owner": true }
--    directly against PostgREST and self-promote to owner (or hop tenants via
--    tenant_id) — bypassing every app-level gate. Lock UPDATE to the safe
--    self-edit columns only; all role/tenant writes go through the service role
--    (setMemberRole, redeem-invite, onboarding wizard, provision-cli), which
--    bypasses column grants, so nothing legitimate breaks.
REVOKE UPDATE ON public.user_profiles FROM anon;
REVOKE UPDATE ON public.user_profiles FROM authenticated;
GRANT UPDATE (
  display_name, full_name, personal_phone, custom_fields, preferred_language,
  brand, primary_agent, prospect_focus, agents_enabled, onboarding_completed_at,
  mrr_current_usd, mrr_target_date, mrr_target_usd, manifesto,
  deal_architecture_version, primary_script_version, updated_at
) ON public.user_profiles TO authenticated;

-- VERIFY: the escalation columns must be ABSENT from authenticated's UPDATE grants.
--   SELECT column_name FROM information_schema.column_privileges
--    WHERE table_name='user_profiles' AND grantee='authenticated' AND privilege_type='UPDATE'
--      AND column_name IN ('is_owner','team_role','admin_access','tenant_id');  -- expect 0 rows
