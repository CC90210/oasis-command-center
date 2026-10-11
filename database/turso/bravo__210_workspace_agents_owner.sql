-- bravo__210_workspace_agents_owner.sql
--
-- O1: only a workspace's AGENTS OWNER may reach that workspace's paired computer.
-- Before this table, authorizeBridgeRequest (lib/bridge-proxy.ts) admitted ANY
-- verified platform operator into OASIS's bridge, so Adon's department chats, the
-- coding harness and fleet control all ran on CC's PC under CC's own Claude
-- sign-in — the opposite of the founders' rule that work runs on the asking
-- person's OWN computer. A row here names the one auth user whose computer the
-- workspace's department chats and bridge tools are allowed to reach.
--
-- No route writes this table. One row is added by hand, by an operator with direct
-- database access, for tenant ef8d389e-3f15-43f2-ae00-3660f69a1452 (OASIS) naming
-- CC's auth user id, read back before this slice merges. Revoke by setting
-- revoked_at, never by deleting the row, so the history of who held the computer
-- survives; a revoked row reads the same as no row (lib/agents-owner.ts).
-- House rules: IF NOT EXISTS everywhere; no CHECK; timestamps are ISO-8601 TEXT.

CREATE TABLE IF NOT EXISTS workspace_agents_owner (
  tenant_id     TEXT PRIMARY KEY,
  auth_user_id  TEXT NOT NULL,
  set_by        TEXT NOT NULL,
  set_at        TEXT NOT NULL,
  note          TEXT,
  revoked_at    TEXT
);
