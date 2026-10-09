-- Skills Training (JARVIS plan 2): label changes, their status per computer, each computer's
-- skill list and live labels (a mirror its check-in writes), and its check-in key as a
-- SHA-256 hash only. No prompt text, file path or vector is ever stored here.
-- House rules: IF NOT EXISTS everywhere; no CHECK constraints on enum columns (allowed values
-- live in lib/skills/contract.ts); booleans are INTEGER 0/1; JSON is TEXT.
CREATE TABLE IF NOT EXISTS skills_computer (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  key_hash TEXT,
  key_issued_at TEXT,
  revoked_at TEXT,
  rebuild_requested_at TEXT,
  skills_sha TEXT,
  last_checkin_at TEXT,
  last_checkin_outcome TEXT,
  last_checkin_detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skills_computer_owner ON skills_computer (owner_user_id);

CREATE TABLE IF NOT EXISTS skills_skill (
  computer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  example_prompts_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (computer_id, name)
);

CREATE TABLE IF NOT EXISTS skills_label (
  computer_id TEXT NOT NULL,
  id TEXT NOT NULL,
  level TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  meaning TEXT NOT NULL DEFAULT '',
  examples_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (computer_id, id)
);

CREATE TABLE IF NOT EXISTS skills_skill_label (
  computer_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  label_id TEXT NOT NULL,
  rank TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (computer_id, skill, label_id)
);

CREATE TABLE IF NOT EXISTS skills_change (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills_change_status (
  change_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  worse INTEGER NOT NULL DEFAULT 0,
  better INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT NOT NULL DEFAULT '{}',
  decided_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (change_id, computer_id)
);
CREATE INDEX IF NOT EXISTS skills_change_status_pending ON skills_change_status (computer_id, status);
