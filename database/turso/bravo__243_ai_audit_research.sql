-- 243 - Free AI Audit, phase 3: the research behind an audit (2026-10-26).
--
-- ai_audit_research  one row per research run of an engagement, after Gate 1:
--                    the client's own website read again, a Google PageSpeed
--                    run, web search on CC's Mac (public facts only) and each
--                    page it found read by the Command Center, the profile's
--                    figures, the impact calculator's estimates, and the gaps.
--                    content is ai_audit_research/v1 JSON (lib/ai-audit/research.ts):
--                    it carries its own sources, each with the excerpt its
--                    facts are checked against, so a run never changes once
--                    written (the trigger below), and an audit written from it
--                    keeps the evidence it cites.
-- ai_audit_assumptions  CC's own ranges for the impact calculator's assumptions
--                    (lib/ai-audit/impact.ts), one row per engagement. The
--                    estimates are recomputed from the run's stored inputs.
--
-- CONVENTIONS as bravo__237: text ids and ISO-8601 UTC times written by the
-- app, tenant_id first in every index, allowed values in code. Additive only,
-- and every statement may run twice.

CREATE TABLE IF NOT EXISTS ai_audit_research (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  engagement_id  TEXT NOT NULL,
  version_no     INTEGER NOT NULL,
  status         TEXT NOT NULL,
  content        TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_by     TEXT,
  created_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_research_no_idx
  ON ai_audit_research (tenant_id, engagement_id, version_no);

CREATE TRIGGER IF NOT EXISTS ai_audit_research_frozen
BEFORE UPDATE ON ai_audit_research
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_research_frozen');
END;

CREATE TABLE IF NOT EXISTS ai_audit_assumptions (
  tenant_id      TEXT NOT NULL,
  engagement_id  TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  updated_by     TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, engagement_id)
);
