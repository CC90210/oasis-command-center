-- 174_training_progress.turso.sql
--
-- What a rep has drilled in the Training tab, and which sections they have
-- finished.
--
-- WHY TWO TABLES RATHER THAN ONE. They answer different questions and change on
-- different clocks. `training_progress` is a per-item counter that moves every
-- few seconds while somebody drills; `training_completion` is a once-per-section
-- fact a manager reads. Folding completion into the counter table would mean
-- deriving "finished" from a threshold on counts, and a threshold is a guess
-- that changes the moment the curriculum does.
--
-- TENANT_ID ON BOTH, first in every index. libSQL has no row-level security, so
-- tenant pinning in the query IS the authorization boundary, exactly as
-- migration 171 states for the objection engine.
--
-- KEYED ON rep_user_id, not profile id. Matches `objection_event` in 171, which
-- is the other per-rep table in this product, so a join between what a rep
-- practised and what they did on a real call does not need a translation step.
--
-- COUNTERS, NOT AN EVENT LOG. A row per attempt would be the more flexible
-- shape and is deliberately not what this is: the only questions anyone has
-- asked of this data are "how is this rep doing" and "which items does this rep
-- get wrong", and both are answered by counts. An event log would also make
-- every drill a write that grows forever, for a feature whose whole point is
-- that a rep does it repeatedly.

CREATE TABLE IF NOT EXISTS training_progress (
  id            text primary key,
  tenant_id     text not null,
  rep_user_id   text not null,
  -- The curriculum item, e.g. "label-standard". Deliberately NOT a foreign key:
  -- the curriculum lives in TypeScript and changes with a deploy, and a rep's
  -- history of an item that was later reworded is still worth keeping. A row
  -- whose item no longer exists is ignored on read rather than failing a write.
  item_id       text not null,
  section_slug  text not null,
  right_count   integer not null default 0,
  wrong_count   integer not null default 0,
  last_seen_at  text not null,
  created_at    text not null,
  updated_at    text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS training_progress_item_uq
  ON training_progress (tenant_id, rep_user_id, item_id);

-- Serves both "this rep's progress in this section" and, for a manager, "this
-- section across the team". Tenant first, then section, so the same index
-- covers the team-wide read without a second one.
CREATE INDEX IF NOT EXISTS training_progress_section_idx
  ON training_progress (tenant_id, section_slug, rep_user_id);

CREATE TABLE IF NOT EXISTS training_completion (
  id            text primary key,
  tenant_id     text not null,
  rep_user_id   text not null,
  section_slug  text not null,
  completed_at  text not null,
  -- The score at the moment it was completed, kept so a later curriculum change
  -- cannot silently rewrite what somebody achieved.
  right_count   integer not null default 0,
  wrong_count   integer not null default 0,
  created_at    text not null,
  updated_at    text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS training_completion_uq
  ON training_completion (tenant_id, rep_user_id, section_slug);

CREATE INDEX IF NOT EXISTS training_completion_section_idx
  ON training_completion (tenant_id, section_slug, completed_at);
