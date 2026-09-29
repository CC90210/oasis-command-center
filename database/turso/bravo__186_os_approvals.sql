-- bravo__186 - OASIS OS approvals ("Needs you") and their append-only audit log
-- (2026-09-28).
--
-- WHAT THIS IS. Every outward action a department proposes (an email, a post,
-- later an SMS or a paused ad) becomes ONE approvals row. A person approves it,
-- sends it back with a note, or comments on it; only an approved row is ever
-- executed, and it is executed exactly once. Design: docs/os-revamp/
-- 02-data-safety-sunbiz-retirement.md §3.3, 01-product-surface-ia-ux.md §(c)
-- Feed and §(f), 03-connectors-ai-finance.md "approvals contract".
--
-- THE APPROVAL BINDS TO THE EXACT PAYLOAD. payload_json is written once, as
-- canonical JSON, and payload_hash is its sha256. Nothing updates payload_json:
-- an edited draft is a NEW row (revision + 1, supersedes_id -> the old row), so
-- a "yes" can never be carried over to words the approver did not read. The
-- approve call must present the hash it was shown, and the executor recomputes
-- the hash from the stored payload before it acts.
--
-- EXACTLY ONCE. The executor claims a row with a compare-and-swap
--   UPDATE approvals SET status = 'executing' ... WHERE tenant_id = ? AND id = ?
--     AND status = 'approved'
-- and acts only when exactly one row changed. idempotency_key is minted when
-- the row is created, is UNIQUE per tenant (a retried create finds the first
-- row instead of making a second), and is handed to the provider where the
-- provider takes one (the OASIS mailbox derives its Message-Id from it).
--
-- CONVENTIONS (binding, from 183_delivery_and_support.turso.sql):
--   - tenant_id is NOT NULL on both tables and LEADS every index. libSQL has no
--     row-level security: the WHERE clause built in lib/os/approvals/store.ts,
--     from the SESSION's tenant, is the authorization boundary.
--   - ids are TEXT, written by the app. Timestamps are ISO-8601 UTC strings
--     written by the app (new Date().toISOString()), so expiry and ordering are
--     plain string comparisons.
--   - NO CHECK CONSTRAINTS on status, action_kind, requested_by_type,
--     risk_level, decided_via or event. The allowed values live once, in
--     lib/os/approvals/rules.ts, pinned by tests/os-approvals.test.ts; SQLite
--     cannot alter a CHECK without rebuilding the table.
--   - Additive only. Nothing here drops or rewrites an existing object.
--
-- Not applied by the author: the lead applies it to production.

-- approvals: one proposed outward action and its whole life.
--   status: pending | approved | sent_back | expired | executing | executed |
--           failed | cancelled                      (lib/os/approvals/rules.ts)
--   department_key: the department that asked (chief_of_staff, sales, ...).
--           NULL = unattributed, which only an owner/admin may decide.
--   requested_by_type: agent | routine | human; requested_by_id: the agent key,
--           routine id or auth user id.
--   title / preview_text: what the card says; payload_json is what executes.
--   decided_by: the auth user id from the approver's SESSION, never from a
--           request body. decided_via: app (later slack | discord | telegram).
--   execution_result: JSON, the executor's own account of what happened
--           ({"outcome":"sent",...} / {"outcome":"failed","message":...}).
CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  department_key     TEXT,
  requested_by_type  TEXT NOT NULL,
  requested_by_id    TEXT,
  routine_run_id     TEXT,
  action_kind        TEXT NOT NULL,
  title              TEXT NOT NULL,
  target_ref         TEXT,
  payload_json       TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  preview_text       TEXT,
  revision           INTEGER NOT NULL DEFAULT 1,
  supersedes_id      TEXT,
  risk_level         TEXT NOT NULL DEFAULT 'normal',
  status             TEXT NOT NULL DEFAULT 'pending',
  decided_by         TEXT,
  decided_at         TEXT,
  decided_via        TEXT,
  decision_note      TEXT,
  execute_after      TEXT,
  executing_at       TEXT,
  executed_at        TEXT,
  execution_result   TEXT,
  idempotency_key    TEXT NOT NULL,
  expires_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_appr_idem ON approvals(tenant_id, idempotency_key);
-- "Needs you": a tenant's pending queue, oldest first; and the recent-decisions list.
CREATE INDEX IF NOT EXISTS ix_appr_queue ON approvals(tenant_id, status, created_at);
-- A department's Needs you (Overview panel, Feed department filter).
CREATE INDEX IF NOT EXISTS ix_appr_dept ON approvals(tenant_id, department_key, status);
-- A revision chain: which row replaced which.
CREATE INDEX IF NOT EXISTS ix_appr_supersedes ON approvals(tenant_id, supersedes_id);
-- An agent reading back its own proposals (list_proposals).
CREATE INDEX IF NOT EXISTS ix_appr_requester ON approvals(tenant_id, requested_by_type, requested_by_id, created_at);

-- approval_events: APPEND-ONLY. Every state change and every comment is one
-- row, written in the same batch as the change it records. The app never
-- UPDATEs or DELETEs this table (tests/os-approvals.test.ts scans the store
-- for it).
--   event: created | approved | sent_back | commented | cancelled |
--          superseded | expired | execution_started | executed | failed
--   actor_type: user | agent | routine | system; actor_id as for approvals.
--   meta: JSON (the comment body, the send-back note, the executor's result).
CREATE TABLE IF NOT EXISTS approval_events (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  approval_id  TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor_type   TEXT,
  actor_id     TEXT,
  meta         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_apev ON approval_events(tenant_id, approval_id, created_at);
