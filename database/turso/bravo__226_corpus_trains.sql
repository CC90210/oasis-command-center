-- Per-agent training (2026-10-15): which department agent a training note trains.
--   a department key  that agent ("sales", "chief_of_staff", ...)   lib/os/departments.ts
--   'all'             every department agent
--   NULL              saved before an agent could be chosen, or by a path that does not choose (the
--                     Content Training page, the background reader): it trains the Marketing agent, who
--                     the notes were always written for. lib/training/trains.ts holds the rule.
-- Nullable and additive: every existing row and every existing writer keeps working unchanged.
ALTER TABLE "marketing_corpus" ADD COLUMN "trains" TEXT;

-- The read an agent makes before it answers: its workspace's newest learned notes.
CREATE INDEX IF NOT EXISTS "idx_marketing_corpus_trains" ON "marketing_corpus" ("tenant_id", "state", "trains", "indexed_at");
