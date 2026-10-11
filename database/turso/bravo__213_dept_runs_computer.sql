-- bravo__213_dept_runs_computer.sql
--
-- O4: a person's own paired computer answers their department chats by PULL
-- dispatch -- the computer calls out (POST /api/bridge/runs/claim); OCC never
-- calls in. Before this, O3a/O3b (bravo__211, bravo__212) let a person CHOOSE
-- their own computer as their engine, but lib/os/runs/session.ts refused every
-- such choice outright: nothing downstream knew how to run a turn ON a
-- person's computer. This migration adds the columns the claim route, its
-- compare-and-swap, its idempotent retry, and its three failure clocks are
-- built on. (M3 in the approved design, numbered 212 there; renumbered 213
-- here because bravo__212_pairing_scope_claim.sql already claimed 212 by the
-- time this slice started -- see the design handoff.)
--
-- executor: 'worker' (the Worker's own driver claims it, lib/os/runs/store.ts
--   claimNextRun) | 'computer' (claimed only by the claim route's
--   compare-and-swap, never by claimNextRun -- the WHERE clause added there
--   in this same slice is the actual enforcement). Defaults to 'worker' so
--   every row ever written before this column existed, and every row any
--   other write path inserts without naming it, keeps running exactly where
--   it always has.
-- claimed_pairing_id: which of the person's bridge_pairings claimed this run.
--   Checked, unrevoked, on every events POST and every MCP tools call for a
--   computer-executor run (disconnecting that computer must stop its run
--   mid-reply, not just stop new ones).
-- origin: 'chat' (a department message) | 'automation' (a department task's
--   run, O5) | 'test' ("Run now", O5). The claim CAS orders chat before test
--   before automation, so a person waiting on an answer is never queued
--   behind a scheduled task that happened to be enqueued first.
-- automation_id / scheduled_for: O5's own columns (which automation, which
--   occurrence). Added here, not later, because every row this migration's
--   claim index and CAS touch needs the SAME shape from day one -- a second
--   ALTER TABLE pass over dept_chat_runs is a second chance to miss a case the
--   claim CAS already depends on. O4's own code never writes either column
--   (both stay NULL on every row O4 inserts).
-- deadline_at: claim time + 20 minutes; the longest an MCP token or a run
--   token may outlive. NULL until claimed.
-- read_outside_text_at: the first moment this run read a tool whose text came
--   from outside the workspace (a lead's note, a ticket, a calendar invite) --
--   O5's "a card drafted after the run read outside text says so" rule reads
--   this. O4 never sets it (it has no automation drafts to annotate).
-- requeue_count: how many times an interrupted automation run has been put
--   back in the queue (O5's own cap). O4 never increments it.
-- first_in_line_at: the moment THIS run first had nothing running ahead of
--   it in its own conversation (Codex review, 2026-10-11, [P2]). Set ONCE,
--   by a CAS (store.ts markFirstInLine, COALESCE against the existing
--   value), the first time any follower observes it -- never reset, and
--   never local to one follower's in-memory state: a stream reattaches
--   every ~25 s (TAIL_WINDOW_MS), and a value kept only in one generator's
--   closure forgot it on every reconnect, so computer_busy_timeout could
--   never fire and a continuously busy computer's queue waited for the
--   10-minute absolute cap instead of the 5-minute busy clock. A run that
--   never becomes first-in-line (claimed, or failed, while something else
--   was still running ahead of it) simply never sets this column.
--
-- dept_chat_conversations.origin / .automation_id: an automation's
-- conversation is its own record (O5); a chat conversation's origin is
-- 'chat', the only value O4 ever writes.
--
-- House rules: additive ALTER TABLE ADD COLUMN only, no CHECK constraints
-- (vocabularies live in code -- lib/os/runs/types.ts), ISO-8601 TEXT
-- timestamps, no comment after a semicolon on the same line. NOT safe to
-- re-run as a whole: SQLite has no ADD COLUMN IF NOT EXISTS.
--
-- Apply first, verify every column name below is free with PRAGMA
-- table_info('dept_chat_runs') / ('dept_chat_conversations'), THEN deploy the
-- code that reads them.

ALTER TABLE dept_chat_runs ADD COLUMN executor TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE dept_chat_runs ADD COLUMN claimed_pairing_id TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE dept_chat_runs ADD COLUMN automation_id TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN scheduled_for TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN deadline_at TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN read_outside_text_at TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dept_chat_runs ADD COLUMN first_in_line_at TEXT;

CREATE INDEX IF NOT EXISTS dept_chat_runs_claim_idx
  ON dept_chat_runs (tenant_id, user_id, executor, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS dept_chat_runs_automation_slot_idx
  ON dept_chat_runs (automation_id, scheduled_for)
  WHERE automation_id IS NOT NULL AND status <> 'missed';

-- Codex review, 2026-10-11, [P2]: the claim route's claim_id dedup (a lost
-- answer retried with the same claim_id finds the SAME run again,
-- idempotently) was a read-then-decide check, never atomic with the claim
-- itself. Two overlapping requests carrying the same claim_id could each
-- find nothing claimed yet, then each successfully CAS-claim a DIFFERENT
-- queued run for that person (a second UPDATE's subquery excludes only the
-- FIRST one's row, not any other), landing two different runs under the
-- one claim_id the connector will only ever ask about once. This partial
-- unique index makes that second UPDATE fail outright (a UNIQUE constraint
-- violation, not a silent second winner): no two RUNNING rows may ever
-- share (claimed_pairing_id, lease_id). NULL claimed_pairing_id (every
-- Worker-driven run) never collides with another NULL -- SQLite does not
-- treat NULLs as equal in a UNIQUE index -- so this touches computer-claimed
-- rows only, and WHERE status = 'running' means a run that later finishes,
-- fails or is reaped frees its (pairing, claim_id) pair for reuse.
CREATE UNIQUE INDEX IF NOT EXISTS dept_chat_runs_pairing_claim_idx
  ON dept_chat_runs (claimed_pairing_id, lease_id)
  WHERE status = 'running' AND claimed_pairing_id IS NOT NULL;

ALTER TABLE dept_chat_conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE dept_chat_conversations ADD COLUMN automation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS dept_chat_conversations_automation_idx
  ON dept_chat_conversations (automation_id)
  WHERE automation_id IS NOT NULL;
