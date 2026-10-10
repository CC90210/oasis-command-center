-- bravo__207_department_chat_runs.sql
--
-- Department channels (/team/<dept>): saved conversations, and every message
-- a run that outlives the page. Additive only.
--
--   dept_chat_conversations  one per person per department channel (private to
--                            that person: nothing here is read across users).
--   dept_chat_runs           one per message sent: the question, its state
--                            (queued -> running -> done | failed | cancelled |
--                            interrupted), the final answer, the lease the
--                            driver holds while it works.
--   dept_chat_run_events     append-only: what the run did, in order (agent,
--                            status, thinking, tool, delta, usage, error,
--                            done). A browser that comes back replays these,
--                            then follows live. Reply text (delta) and
--                            reasoning (thinking) rows are dropped once the run
--                            finishes: the answer is final_text on the run, and
--                            reasoning is never kept. (run_id, seq) is unique,
--                            so a producer that posts an event twice writes it
--                            once.
--
-- House rules: IF NOT EXISTS everywhere; vocabularies live in lib/os/runs/types.ts
-- (no CHECK); JSON is TEXT; timestamps are ISO-8601 UTC. Retention is the
-- account's: a conversation lives with the workspace and is deleted by the
-- person who owns it (DELETE /api/agents/conversations/<id> removes its runs
-- and events), or with the workspace.

CREATE TABLE IF NOT EXISTS dept_chat_conversations (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  department_key   TEXT NOT NULL,
  agent_slug       TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  title_source     TEXT NOT NULL DEFAULT 'auto',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_message_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dept_chat_conversations_list_idx
  ON dept_chat_conversations (tenant_id, user_id, department_key, last_message_at DESC);

CREATE TABLE IF NOT EXISTS dept_chat_runs (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  conversation_id      TEXT NOT NULL,
  department_key       TEXT NOT NULL,
  agent_slug           TEXT NOT NULL,
  seq                  INTEGER NOT NULL,
  status               TEXT NOT NULL,
  user_text            TEXT NOT NULL,
  chat_mode            TEXT NOT NULL DEFAULT 'build',
  -- Who writes this run's events: 'worker' (the driver in the Worker, the
  -- default) or 'producer' (the paired computer's bridge, posting them to
  -- POST /api/os/runs/<id>/events with a run-scoped token). A producer run is
  -- stale after 120 s without an event, a worker run after 45 s.
  source               TEXT NOT NULL DEFAULT 'worker',
  -- 1 when the person may see the model's reasoning (owner, admin, operator).
  -- Reasoning is never saved: it exists only while the run works.
  show_thinking        INTEGER NOT NULL DEFAULT 0,
  final_text           TEXT,
  agent_json           TEXT,
  error_code           TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  lease_id             TEXT,
  heartbeat_at         TEXT,
  cancel_requested_at  TEXT,
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS dept_chat_runs_conversation_seq_idx
  ON dept_chat_runs (conversation_id, seq);
CREATE INDEX IF NOT EXISTS dept_chat_runs_user_status_idx
  ON dept_chat_runs (tenant_id, user_id, status);

CREATE TABLE IF NOT EXISTS dept_chat_run_events (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  tenant_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
