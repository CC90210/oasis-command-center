-- bravo__211_automation_owner.sql
--
-- O2: each person sees and manages their OWN automations; the house lane
-- (cron_jobs) and the background workers belong to the workspace's AGENTS
-- OWNER only (lib/agents-owner.ts, database/turso/bravo__210_workspace_agents_owner.sql).
-- Before this column, tenant_cron_jobs had no idea who a row belonged to —
-- POST /api/cron-jobs stamped created_by with the auth id, but
-- /api/automations/save-draft stamped it with the user_profiles.id instead
-- (two different kinds of value in the same column), so no reader could use
-- created_by as an ownership fact. owner_user_id is written once, at insert,
-- and never changes afterwards.
--
-- last_scheduled_for and tz are read by O5 (the per-person due-time
-- evaluator); they are added here, not there, because every row this
-- migration touches needs a value for all four new columns at once, and a
-- second ALTER TABLE pass over the same table is a second chance to miss a
-- row. last_poll_ok_at on bridge_pairings is O2's own: the moment a cron poll
-- last answered that computer with 200, so attention.ts can say "the house
-- scheduler has not fetched jobs for N minutes" instead of staying silent.
--
-- NOT RE-RUNNABLE AS A WHOLE: SQLite has no ADD COLUMN IF NOT EXISTS, and the
-- backfill below is a one-time UPDATE, not an idempotent assignment.
--
-- Apply first, verify with PRAGMA table_info, THEN deploy the code that reads
-- these columns: if the code ships before the column exists, the poll route's
-- explicit column read fails with "no such column" (answered as a named 503,
-- never a 500 with driver text) and the GET/PATCH routes fall back to
-- treating every row as unowned (the pre-O2, canManageTeam-gated rule) until
-- the migration lands.
--
-- Backfill order (each step only touches rows still NULL after the step
-- before it):
--   1. owner_user_id = created_by, where created_by is itself an auth user id
--      (it matches some user_profiles.auth_user_id row IN THE SAME TENANT).
--      This is the POST /api/cron-jobs shape.
--   2. owner_user_id = that profile's auth_user_id, where created_by is a
--      user_profiles.id in the same tenant (the save-draft shape: it wrote
--      the PROFILE id, not the auth id).
--   3. OASIS tenant only (ef8d389e-3f15-43f2-ae00-3660f69a1452): every row
--      still NULL becomes the workspace's non-revoked agents-owner row's
--      auth_user_id. Production fact (probed 2026-10-11): tenant_cron_jobs
--      has 4 rows total, all OASIS, all action_type script_run, all
--      created_by NULL — so this step alone makes all 4 CC's.
-- Rows in OTHER workspaces that are still NULL after step 2 stay NULL. They
-- are legacy rows with no recorded owner, served only to daemon computers
-- through today's label gate (app/api/cron-jobs/poll/route.ts), and treated
-- as unowned (visible to whoever already managed them) by the GET/PATCH
-- routes — never silently reassigned to a guess.
--
-- Check after applying: the count of OASIS rows with owner_user_id IS NULL
-- must be 0. The list of OASIS rows whose owner is not CC goes into the O2
-- PR description.

ALTER TABLE tenant_cron_jobs ADD COLUMN owner_user_id TEXT;       -- auth user id; never changes after insert
ALTER TABLE tenant_cron_jobs ADD COLUMN last_scheduled_for TEXT;  -- newest occurrence already enqueued or marked missed (O5's CAS key)
ALTER TABLE tenant_cron_jobs ADD COLUMN tz TEXT;                  -- IANA zone the schedule is read in (the owner's)
ALTER TABLE bridge_pairings ADD COLUMN last_poll_ok_at TEXT;      -- the cron poll last answered this computer with 200

-- Step 1: created_by is an auth user id with a user_profiles row in the SAME tenant.
UPDATE tenant_cron_jobs
SET owner_user_id = created_by
WHERE owner_user_id IS NULL
  AND created_by IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_profiles.auth_user_id = tenant_cron_jobs.created_by
      AND user_profiles.tenant_id = tenant_cron_jobs.tenant_id
  );

-- Step 2: created_by is a user_profiles.id (save-draft's shape) in the SAME tenant.
UPDATE tenant_cron_jobs
SET owner_user_id = (
  SELECT user_profiles.auth_user_id FROM user_profiles
  WHERE user_profiles.id = tenant_cron_jobs.created_by
    AND user_profiles.tenant_id = tenant_cron_jobs.tenant_id
  LIMIT 1
)
WHERE owner_user_id IS NULL
  AND created_by IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_profiles.id = tenant_cron_jobs.created_by
      AND user_profiles.tenant_id = tenant_cron_jobs.tenant_id
      AND user_profiles.auth_user_id IS NOT NULL
  );

-- Step 3: OASIS only — everything still NULL becomes the agents owner.
UPDATE tenant_cron_jobs
SET owner_user_id = (
  SELECT auth_user_id FROM workspace_agents_owner
  WHERE workspace_agents_owner.tenant_id = tenant_cron_jobs.tenant_id
    AND workspace_agents_owner.revoked_at IS NULL
  LIMIT 1
)
WHERE owner_user_id IS NULL
  AND tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
  AND EXISTS (
    SELECT 1 FROM workspace_agents_owner
    WHERE workspace_agents_owner.tenant_id = tenant_cron_jobs.tenant_id
      AND workspace_agents_owner.revoked_at IS NULL
  );

CREATE INDEX IF NOT EXISTS idx_tenant_cron_jobs_owner ON tenant_cron_jobs (tenant_id, owner_user_id, enabled);
