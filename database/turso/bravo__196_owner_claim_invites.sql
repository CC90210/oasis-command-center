-- bravo__196_owner_claim_invites.sql - the founder's invite into a workspace
-- OASIS set up for them (OASIS OS S2 T7, 2026-09-30).
--
-- WHY. A client founder could not be invited into their own workspace. Team
-- invites (app/api/team/invites) never mint an owner and only reach the
-- inviter's own workspace, so the only way a client workspace got an owner was
-- the self-serve wizard promoting whoever called it first. The operator's
-- /admin/installs page now mints ONE owner invite per workspace; redeeming it
-- makes the founder the workspace owner (user_profiles.is_owner = 1,
-- team_role 'owner') in the same write that claims the invite.
--
-- kind   'member'       every invite before this migration, and every team
--                       invite after it. Redeeming one never makes an owner,
--                       whatever its team_role says.
--        'owner_claim'  minted only by
--                       app/api/admin/installs/[tenantId]/owner-invite (a
--                       verified platform operator). Redeeming it sets
--                       is_owner = 1 and team_role = 'owner'.
--
-- The DEFAULT backfills every existing row as 'member', which is what each of
-- them is. A CHECK is part of the new column (SQLite cannot add one to an
-- existing column): only an invite this migration knows about can exist.
--
-- provisioning_runs already exists in production (183_delivery_and_support,
-- 0 rows as of 2026-09-29). The CREATE below is IF NOT EXISTS with 183's exact
-- shape, so it is a no-op there and creates the table on any database built
-- without 183. lib/provisioning/provision-tenant.ts writes one run per
-- provisioning, and the client's "being set up" page reads its steps.
--
-- ORDERING. The code that ships with this file treats a missing `kind` column
-- as "every invite is a member invite" (lib/turso-rpc-shim.ts
-- redeem_tenant_invite) and the owner-invite route refuses with a 503 naming
-- this migration until it is applied. Safe to apply before or after deploy.
-- Additive only.

ALTER TABLE tenant_invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'member'
  CHECK (kind IN ('member', 'owner_claim'));

CREATE TABLE IF NOT EXISTS provisioning_runs (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id      TEXT NOT NULL,
  tenant_slug    TEXT,
  stripe_invoice TEXT,
  status         TEXT DEFAULT 'pending',
  steps_json     TEXT DEFAULT '[]',
  error_message  TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prov_tenant ON provisioning_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_prov_status ON provisioning_runs(status);
