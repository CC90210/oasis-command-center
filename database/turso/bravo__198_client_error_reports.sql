-- bravo__198_client_error_reports.sql
--
-- Browser-side crashes, reported by the page itself through
-- POST /api/client-errors (app/api/client-errors/route.ts): every error the
-- boundaries app/error.tsx and app/global-error.tsx catch, plus uncaught errors
-- and rejected promises (components/ClientErrorReporter.tsx).
--
-- Why: a crash in a client component shows "Something went wrong" with NO
-- error code and never reached the Worker's logs. On 2026-10-01 the pipeline
-- failed for a user on every other click while the server logged nothing.
--
-- One row per report. The route caps size and rate, keeps the pathname only
-- (never a query string), masks credentials in paths, messages and stacks
-- (/sign/, /invite/ and personalised form tokens, long opaque segments),
-- strips control characters, and takes tenant_id and user_id from the session,
-- never from the payload. Only reports from a signed-in session are stored; an
-- anonymous report is logged only (lib/client-errors/ingest.ts). Rows older than 30
-- days are pruned every 15 minutes by /api/cron/connection-health
-- (lib/client-errors/retention.ts).
--
-- Additive only. The route works before this file is applied: it logs the
-- report and skips the insert.

CREATE TABLE IF NOT EXISTS client_error_reports (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  user_id     TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('boundary', 'global', 'window', 'rejection')),
  name        TEXT,
  message     TEXT NOT NULL,
  stack       TEXT,
  digest      TEXT,
  path        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_client_error_reports_created
  ON client_error_reports (created_at);

CREATE INDEX IF NOT EXISTS idx_client_error_reports_tenant_created
  ON client_error_reports (tenant_id, created_at);
