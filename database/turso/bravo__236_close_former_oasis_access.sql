-- bravo__236_close_former_oasis_access.sql
--
-- Complete the former OASIS collaborator's technical offboarding. Historical
-- rows remain available for evidence; every credential, session, invite, pair
-- code and computer authority controlled by that identity is made unusable.
-- Each statement is idempotent and scoped to the exact former auth identity.

-- Stop password and Google login and invalidate cookies already in circulation.
UPDATE _supabase_auth_users
   SET banned_until = '9999-12-31T23:59:59Z',
       session_version = session_version + 1,
       updated_at = '2026-10-21T21:32:00Z'
 WHERE id = '67036c9a-de2e-47cd-89bd-af19004585b1'
   AND (banned_until IS NULL OR banned_until <> '9999-12-31T23:59:59Z');

-- A reset token must not provide a route around the login ban.
UPDATE _auth_tokens
   SET used_at = COALESCE(used_at, '2026-10-21T21:32:00Z')
 WHERE lower(email) = 'adon@oasisai.work'
   AND used_at IS NULL;

-- Revoke every live computer and remove its ability to claim queued work.
UPDATE bridge_pairings
   SET revoked_at = '2026-10-21T21:30:00Z',
       claim_enabled_at = NULL,
       claim_enabled_by = NULL,
       claim_capacity = 0,
       claim_in_flight = 0,
       claim_blocked_reason = 'former_collaborator_offboarded'
 WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
   AND user_id = '67036c9a-de2e-47cd-89bd-af19004585b1'
   AND revoked_at IS NULL;

-- Expire any desktop pairing code, including one created after the original
-- pairing but before this migration reaches another environment.
UPDATE bridge_pair_codes
   SET consumed_at = COALESCE(consumed_at, '2026-10-21T21:32:00Z')
 WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
   AND auth_user_id = '67036c9a-de2e-47cd-89bd-af19004585b1'
   AND consumed_at IS NULL;

-- Keep invite history, but no old OASIS invitation may become a new seat.
UPDATE tenant_invites
   SET revoked_at = COALESCE(revoked_at, '2026-10-21T21:32:00Z')
 WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
   AND lower(email) = 'adon@oasisai.work';

-- The remaining user-scoped model row contained its own encrypted Google key.
-- Wipe that credential and disable the row without erasing its audit identity.
UPDATE agent_model_config
   SET enabled = 0,
       encrypted_api_key = NULL,
       updated_at = '2026-10-21T21:32:00Z'
 WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
   AND user_id = '67036c9a-de2e-47cd-89bd-af19004585b1';
