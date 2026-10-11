-- bravo__212_pairing_scope_claim.sql
--
-- O3a: a computer belongs to a person, needs their approval, and stops the
-- moment that person leaves. Before this, a pairing bound only who proved
-- their identity (O0) and the tunnelled computer answered only its owner
-- (O1) -- but every live pairing was still read as an undifferentiated
-- "paired computer": any token reached ping, poll AND record writes, and
-- nothing recorded whether the person who holds it has ever approved it for
-- work. This migration adds the columns O3a's claim gate, approval endpoint
-- and reuse-after-rotation detection are built on.
--
-- scope: 'connector' | 'daemon'; NULL on every row that predates this column
-- reads as 'daemon' (lib/bridge/pairing-auth.ts) -- CCPC and CC's Mac must
-- keep polling, pinging and writing records with ZERO change.
-- paired_via: 'pair_code' | 'hmac' | 'signup_secret'; NULL on a legacy row.
-- claim_protocols: a JSON array the computer advertises at ping
-- (['department_task_v1', ...]), stored in its OWN column -- never folded
-- into tool_capabilities, which feeds the operator chat's bridge tool list.
-- claim_enabled_at / claim_enabled_by: the owner's approval, from their own
-- signed-in session. NULL means the computer cannot be claimed for work.
-- claude_account_hash: sha256(orgId) recorded at approval, to catch an
-- account swap or a shared sign-in.
-- claim_state_at / claim_capacity / claim_in_flight / claim_blocked_reason /
-- last_claim_ip: the per-computer claim-loop state (O4) -- added here
-- because they live on the same row scope governs.
-- previous_token_hash / token_rotated_at: the prior bearer, kept for a 60 s
-- grace window after a rotation; used after the grace to detect a replaced
-- token being reused and revoke the computer.
--
-- bridge_pair_codes gets purpose ('desktop' keeps today's sign-in-link code;
-- 'connector' mints no sign-in link and lives 5 minutes) and the scope it
-- hands the pairing it redeems into.
--
-- agent_model_config gets a per-user unique index on the '__engine__' row
-- (O3b): a person's own engine choice, one row per (tenant, user, agent_key).
--
-- House rules: no CHECK (vocabularies live in code); ISO-8601 TEXT
-- timestamps; SQLite has no ADD COLUMN IF NOT EXISTS, so this file is not
-- safe to re-run as-is -- matches every other ALTER-TABLE migration here.

ALTER TABLE bridge_pairings ADD COLUMN scope TEXT;
ALTER TABLE bridge_pairings ADD COLUMN paired_via TEXT;
ALTER TABLE bridge_pairings ADD COLUMN claim_protocols TEXT;
ALTER TABLE bridge_pairings ADD COLUMN claim_enabled_at TEXT;
ALTER TABLE bridge_pairings ADD COLUMN claim_enabled_by TEXT;
ALTER TABLE bridge_pairings ADD COLUMN claude_account_hash TEXT;
ALTER TABLE bridge_pairings ADD COLUMN claim_state_at TEXT;
ALTER TABLE bridge_pairings ADD COLUMN claim_capacity INTEGER;
ALTER TABLE bridge_pairings ADD COLUMN claim_in_flight INTEGER;
ALTER TABLE bridge_pairings ADD COLUMN claim_blocked_reason TEXT;
ALTER TABLE bridge_pairings ADD COLUMN last_claim_ip TEXT;
ALTER TABLE bridge_pairings ADD COLUMN previous_token_hash TEXT;
ALTER TABLE bridge_pairings ADD COLUMN token_rotated_at TEXT;

ALTER TABLE bridge_pair_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'desktop';
ALTER TABLE bridge_pair_codes ADD COLUMN scope TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_model_config_engine_per_user
  ON agent_model_config (tenant_id, user_id, agent_key)
  WHERE user_id IS NOT NULL AND agent_key = '__engine__';
