-- 241 - Free AI Audit: the pre-call research brief (2026-10-26, phase 2d).
--
-- ai_audit_sources  what the brief was built from, one row per item read: each
--                   request made to the client's own website (a page, its
--                   robots.txt, its sitemap, the plain-HTTP check; fetched by
--                   the Command Center, never with a login), or the answers the
--                   client gave on the AI-audit form. Only a short excerpt and a
--                   hash of each response are kept, never the whole page. A row
--                   never changes once written (a trigger refuses it): the
--                   brief's Verified facts rest on these rows. `kind`
--                   and `reliability` are vocabularies kept in
--                   lib/ai-audit/briefs.ts. Phase 3's research adds kinds
--                   (search results, PageSpeed).
-- ai_audit_briefs   each version of an engagement's pre-call brief: facts
--                   with their labels (Verified for our own measurement,
--                   Client-reported for the form), likely problems as
--                   hypotheses with how to test them, facts to confirm and the
--                   questions to weight on the call. Internal only: the client
--                   never sees a brief. A new build is a new version. The tick's
--                   tries are ai_audit_events rows (brief_attempt), not columns.
--
-- CONVENTIONS as bravo__237: text ids, ISO-8601 UTC times written by the app,
-- tenant_id first in every index. Additive only.

CREATE TABLE IF NOT EXISTS ai_audit_sources (
  id            text not null primary key,
  tenant_id     text not null,
  engagement_id text not null,
  brief_id      text,
  kind          text not null,
  url           text,
  final_url     text,
  http_status   integer,
  retrieved_at  text not null,
  content_sha256 text,
  bytes         integer,
  excerpt       text,
  reliability   text not null,
  meta_json     text not null default '{}',
  created_at    text not null
);

CREATE INDEX IF NOT EXISTS ai_audit_sources_engagement_idx
  ON ai_audit_sources (tenant_id, engagement_id, retrieved_at);
CREATE INDEX IF NOT EXISTS ai_audit_sources_brief_idx
  ON ai_audit_sources (tenant_id, brief_id);

CREATE TABLE IF NOT EXISTS ai_audit_briefs (
  id             text not null primary key,
  tenant_id      text not null,
  engagement_id  text not null,
  version_no     integer not null,
  status         text not null,
  site_url       text,
  content        text not null,
  content_sha256 text not null,
  created_by     text,
  created_at     text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_briefs_no_idx
  ON ai_audit_briefs (tenant_id, engagement_id, version_no);

-- A brief, once written, is what CC read before his call: it never changes.
CREATE TRIGGER IF NOT EXISTS ai_audit_briefs_frozen
BEFORE UPDATE ON ai_audit_briefs
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_brief_frozen');
END;

-- A source is what a Verified fact rests on (what was read, when, its hash):
-- it never changes either.
CREATE TRIGGER IF NOT EXISTS ai_audit_sources_frozen
BEFORE UPDATE ON ai_audit_sources
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_source_frozen');
END;
