-- bravo__214_consent_events.sql - the consent ledger (OCC takeover, V0 slice,
-- 2026-10-11).
--
-- WHAT THIS IS. OASIS's own public funnel (/f/oasis-ai-cc/ai-audit) asks for a
-- mobile number and records no consent at all. Consent sealing exists only for
-- SunBiz and Bluerise, through a third-party vault (lib/consent/optinvault.ts,
-- lib/consent/brand-for-tenant.ts) that captures NOTHING for every other
-- workspace. This table is the first-party, insert-only record of what a
-- visitor was actually shown and whether they ticked it, for EVERY workspace's
-- public forms. SunBiz and Bluerise keep the vault unchanged; this is additive
-- for everyone else, including OASIS's own funnels.
--
-- ONE ROW PER CONSENT DECISION. A decision is "this channel's disclosure was
-- rendered on this step, and the visitor ticked it or did not" -- recorded
-- whether ticked is true or false, because "they saw this and declined" is
-- itself the evidence that unticks a channel for marketing. Never one row per
-- form; a form with both an email and an SMS box renders TWO decisions.
--
-- NO UPDATE, NO DELETE, anywhere in this codebase (enforced by omission and
-- pinned by tests/consent-ledger.test.ts, which greps the repo for any SQL or
-- PostgREST call that would mutate an existing row). The triggers below are
-- defence in depth, mirroring the outcome_events pattern in
-- bravo__190_ledger_core.sql -- a row, once written, is permanent.
--
-- disclosure_hash is sha256 of the EXACT text rendered to the visitor,
-- computed server-side from the server's own disclosure template and the
-- server's own resolved business identity (lib/consent/ledger-disclosure.ts).
-- The client sends only which boxes it rendered and which were ticked; it can
-- never supply the text, the hash, or the version -- a forged or tampered
-- value is simply never read by the submit route (lib/consent/ledger.ts
-- recomputes everything from server state, see app/api/forms/submit/route.ts).
--
-- ip_address comes from Cloudflare's cf-connecting-ip header on the inbound
-- request, never from the submitted body -- a client can set any IP it likes
-- in a JSON field, and this evidence is worthless if it can be forged by the
-- party it is evidence against.
--
-- House rules (bravo__190_ledger_core.sql, bravo__213_dept_runs_computer.sql):
--   - tenant_id TEXT NOT NULL, every tenant index LEADS with tenant_id.
--     libSQL has no row-level security -- the WHERE built in
--     lib/consent/ledger.ts is the isolation boundary.
--   - NO CHECK constraints on the vocabularies (channel: 'email' | 'sms').
--     They live once, in lib/consent/ledger-disclosure.ts, and
--     tests/consent-ledger.test.ts pins them.
--   - ids are TEXT written by the app (randomUUID). Timestamps are ISO-8601
--     UTC strings written by the app (Date.toISOString()).
--   - No comment after a semicolon on the same line (the applier splits on
--     ';' plus newline).
--
-- Apply first, verify the table name is free with
--   node scripts/turso_sql.mjs --db bravo-empire --json
--     "SELECT name FROM sqlite_master WHERE name LIKE 'consent%'"
-- THEN deploy the code that reads/writes it.

CREATE TABLE IF NOT EXISTS consent_events (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  lead_id            TEXT NOT NULL,
  form_id            TEXT NOT NULL,
  channel            TEXT NOT NULL,
  ticked             INTEGER NOT NULL,
  disclosure_hash    TEXT NOT NULL,
  disclosure_version TEXT NOT NULL,
  disclosure_text    TEXT NOT NULL,
  ip_address         TEXT,
  user_agent         TEXT,
  page_url           TEXT,
  identity_source    TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

-- hasTickedConsent (lib/consent/ledger.ts): the marketing-send gate's hot path
-- -- "has THIS lead ticked THIS channel, on any form, ever". tenant_id leads so
-- a cross-tenant query is structurally impossible, not merely unlikely.
CREATE INDEX IF NOT EXISTS ix_consent_events_lead_channel
  ON consent_events (tenant_id, lead_id, channel, created_at);

-- Per-form review (an operator asking "who ticked this form's SMS box").
CREATE INDEX IF NOT EXISTS ix_consent_events_form
  ON consent_events (tenant_id, form_id, channel, created_at);

-- Append-only: a correction is a new row (e.g. a later submission on the same
-- lead that re-renders the disclosure and records a fresh tick/decline), never
-- an edit of one already written. Mirrors outcome_events_no_update in
-- bravo__190_ledger_core.sql.
--
-- ONE LINE, DELIBERATELY. The applier (scripts/turso_sql.mjs
-- splitSqlStatements) splits on a bare `;` immediately followed by a newline
-- -- it is not a real parser. A trigger body written across multiple lines,
-- the way bravo__190_ledger_core.sql's own triggers are, puts the inner
-- `RAISE(...);` right before a newline and gets cut in half: `END;` survives
-- on its own as an unparseable second statement. Keeping BEGIN..END on one
-- line means the only `;\n` the splitter can see is the real terminator.
CREATE TRIGGER IF NOT EXISTS consent_events_no_update BEFORE UPDATE ON consent_events BEGIN SELECT RAISE(ABORT, 'consent_events is insert-only - record a new decision, never edit one'); END;

-- No grant table, no exception: unlike outcome_events (which the tenant
-- offboard purge may clear, a whole tenant at a time, via
-- ledger_purge_grants), this table has NO delete path at all. Evidence that
-- someone consented, or declined, must outlive the lead, the form and the
-- tenant's own retention policy -- it is what proves what happened, not
-- business state that can be reset. Same one-line shape as above, same reason.
CREATE TRIGGER IF NOT EXISTS consent_events_no_delete BEFORE DELETE ON consent_events BEGIN SELECT RAISE(ABORT, 'consent_events is insert-only - there is no delete path for consent evidence'); END;
