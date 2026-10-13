-- Skills Training (JARVIS plan 3): each computer's test record per skill and score per kind of
-- work, as COUNTS only: n = test prompts, ok = how many routed right. No prompt text, key or
-- per-prompt row is ever stored. Replaced together on a skill-list push that carries them; a push
-- without them leaves the last record in place.
-- House rules: IF NOT EXISTS everywhere; no CHECK constraints; integers only.
CREATE TABLE IF NOT EXISTS skills_skill_test (
  computer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  n INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (computer_id, name)
);

CREATE TABLE IF NOT EXISTS skills_kind_score (
  computer_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (computer_id, label_id)
);
