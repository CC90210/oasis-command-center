-- bravo__190_ledger_core.sql - the Business Ledger core (OASIS OS plan v2 §F2.1,
-- 2026-09-29).
--
-- WHAT THIS IS. One append-only, tenant-scoped record of what the business and
-- its agents did: a lead captured, a meeting booked, an approval decided, a
-- payment received. Today, Feed, department numbers and the metric registry
-- read it instead of re-deriving history from rows that get overwritten.
--
--   outcome_events              the ledger. One row per business fact.
--   ledger_purge_grants         the ONLY way a ledger row can be deleted (below).
--   ledger_dead_letters         events a producer sent that the ledger refused,
--                               kept so Operations sees them; the producer keeps
--                               retrying because /api/ledger/ingest answered
--                               non-2xx.
--   ledger_reconciliation_runs  the nightly "ledger replay equals current state"
--                               checks (§F2.3). Written by the reconcile job
--                               that lands in a follow-up PR.
--
-- HOW ROWS GET IN. Only through lib/ledger/emit.ts, which RETURNS an INSERT for
-- the caller's own db.batch, so the business write and its ledger row commit
-- or roll back together. Python producers (BEA, Maven, Atlas) never write these
-- tables; they POST to /api/ledger/ingest (HMAC per producer).
--
-- CONVENTIONS (binding, from 183_delivery_and_support.turso.sql and
-- bravo__186/187):
--   - tenant_id TEXT NOT NULL on every tenant table, and every tenant index
--     LEADS with tenant_id. libSQL has no row-level security: the WHERE built
--     in lib/ledger/read.ts is the isolation boundary.
--   - ids are TEXT written by the app. outcome_events.id is a ULID, so ids sort
--     in time order. Timestamps are ISO-8601 UTC strings written by the app
--     (Date.toISOString()), so ranges are plain string comparisons.
--   - NO CHECK constraints on the vocabularies (event_key, actor_type, source,
--     confidence, department_key, subject_type). They live once, in
--     lib/ledger/catalog.ts, and tests/ledger-core.test.ts pins them.
--   - payload_json holds ids and codes only, never free-text PII, so a Law 25
--     erasure of a person never has to rewrite the ledger.
--   - Additive only. Nothing here drops or rewrites an existing object.
--
-- Not applied by the author: the lead applies it to production BEFORE the code
-- that ships with it is deployed. The approvals store mirrors every decision
-- into outcome_events in the same batch, so without this table an approval
-- write fails loudly (it never half-writes). That includes approvals approved
-- BEFORE the deploy: executing one checks that outcome_events exists before it
-- claims the row, so until this is applied an approved email or post is
-- refused before it goes out (the row stays `approved` and can be pressed
-- again), never sent with its outcome unrecorded.

-- ── outcome_events ─────────────────────────────────────────────────────────
-- event_key / event_version  a catalog entry (lib/ledger/catalog.ts).
-- occurred_at   when it happened at the SOURCE (provider time).
-- recorded_at   when the ledger stored it (server UTC, ms).
-- subject_type / subject_id  what the fact is about (lead, approval, ...).
-- contact_id / deal_id / customer_id  join keys, required per catalog entry.
-- actor_type    human | agent | system | external   (validated in code)
-- source        native | stripe | gmail | zernio | meta | calendar | twilio |
--               recall | import | backfill          (validated in code)
-- confidence    verified | inferred | human_confirmed; a backfill is always
--               inferred.
-- idempotency_key  UNIQUE per tenant. A re-sent event is a no-op.
-- payload_hash  sha256 of the fact: what happened, when, to whom, by whom,
--               counted where, linked to what, for how much
--               (ledgerPayloadHash in lib/ledger/emit.ts). The same key with a
--               DIFFERENT hash is a producer reusing a key for another fact,
--               and the emitter raises it loudly.
-- producer      the module that wrote it (a repo path, or ingest:<producer>).
CREATE TABLE IF NOT EXISTS outcome_events (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  event_key        TEXT NOT NULL,
  event_version    INTEGER NOT NULL,
  occurred_at      TEXT NOT NULL,
  recorded_at      TEXT NOT NULL,
  subject_type     TEXT NOT NULL,
  subject_id       TEXT NOT NULL,
  contact_id       TEXT,
  deal_id          TEXT,
  customer_id      TEXT,
  department_key   TEXT NOT NULL,
  actor_type       TEXT NOT NULL,
  actor_id         TEXT,
  source           TEXT NOT NULL,
  source_ref       TEXT,
  idempotency_key  TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  causation_id     TEXT,
  correlation_id   TEXT,
  approval_id      TEXT,
  routine_run_id   TEXT,
  touch_id         TEXT,
  value_cents      INTEGER,
  currency         TEXT,
  confidence       TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  producer         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outcome_events_idem
  ON outcome_events (tenant_id, idempotency_key);
-- countByKey and coverage (lib/ledger/read.ts): one key over a date range.
CREATE INDEX IF NOT EXISTS ix_outcome_events_key
  ON outcome_events (tenant_id, event_key, occurred_at);
-- latestFor: one subject's history.
CREATE INDEX IF NOT EXISTS ix_outcome_events_subject
  ON outcome_events (tenant_id, subject_type, subject_id, occurred_at);
-- A contact's and a deal's journey.
CREATE INDEX IF NOT EXISTS ix_outcome_events_contact
  ON outcome_events (tenant_id, contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_outcome_events_deal
  ON outcome_events (tenant_id, deal_id, occurred_at);

-- ── ledger_purge_grants ────────────────────────────────────────────────────
-- THE ONE DELETE PATH. A ledger row is never edited and never deleted, with a
-- single exception: the tenant offboard purge (Law 25 erasure of a retired
-- workspace) removes a WHOLE tenant's ledger. It does so in ONE transaction:
--   INSERT INTO ledger_purge_grants (tenant_id, granted_by, reason, granted_at) ...;
--   DELETE FROM outcome_events WHERE tenant_id = ?;
--   DELETE FROM ledger_purge_grants WHERE tenant_id = ?;
-- The delete trigger below refuses any row whose tenant has no grant, so a
-- stray DELETE, an app bug or a WHERE that matches the wrong tenant aborts.
-- In this repo the privileged function is purgeTenantLedger in
-- lib/ledger/purge.ts, which refuses any tenant that is not in
-- lib/tenant/retired.ts; the BEA offboard tool (tenant_offboard.py) must run
-- the same three statements as one transaction. This stops accidents, not a
-- holder of the database token, who could insert a grant row directly.
CREATE TABLE IF NOT EXISTS ledger_purge_grants (
  tenant_id   TEXT PRIMARY KEY,
  granted_by  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  granted_at  TEXT NOT NULL
);

-- Append-only: a correction is a new *.corrected event with a causation_id,
-- never an edit. (This also makes tenant_id immutable on this table.)
CREATE TRIGGER IF NOT EXISTS outcome_events_no_update
BEFORE UPDATE ON outcome_events
BEGIN
  SELECT RAISE(ABORT, 'outcome_events is append-only - record a correction as a new event');
END;

CREATE TRIGGER IF NOT EXISTS outcome_events_no_delete
BEFORE DELETE ON outcome_events
WHEN NOT EXISTS (SELECT 1 FROM ledger_purge_grants g WHERE g.tenant_id = OLD.tenant_id)
BEGIN
  SELECT RAISE(ABORT, 'outcome_events is append-only - only the tenant offboard purge deletes, a whole tenant at a time');
END;

-- REPLACE is a delete in disguise. INSERT OR REPLACE / REPLACE INTO on an
-- existing id or (tenant_id, idempotency_key) deletes the stored row and
-- writes new content, and SQLite fires no DELETE trigger for that delete while
-- recursive_triggers is off (libSQL's default). So an insert that would
-- collide is dropped before conflict resolution runs: it becomes the same
-- no-op an ON CONFLICT DO NOTHING re-send already is, and the stored row
-- stands. Only the colliding row is dropped; the rest of a multi-row insert
-- still lands.
CREATE TRIGGER IF NOT EXISTS outcome_events_no_replace
BEFORE INSERT ON outcome_events
WHEN EXISTS (SELECT 1 FROM outcome_events e WHERE e.id = NEW.id)
  OR EXISTS (SELECT 1 FROM outcome_events e WHERE e.tenant_id = NEW.tenant_id AND e.idempotency_key = NEW.idempotency_key)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- ── ledger_dead_letters ────────────────────────────────────────────────────
-- One row per distinct refused event per producer. A producer that keeps
-- re-sending the same bad event bumps attempts and last_seen on the same row
-- (fingerprint = sha256 of the producer and the event as sent).
-- tenant_hint   the tenant the event named or resolved to, NULL when it named
--               none. Not an authority: the event was refused.
-- payload_json  the event as sent, REDACTED: any string that is not a plain
--               id or code is replaced, so a payload refused for carrying an
--               email address does not park that address here.
-- error         the refusal code and the field it concerns.
--
-- TWO DELIBERATE EXCEPTIONS TO "indexes lead with tenant_id": a dead letter's
-- tenant is exactly what may be unknown, and Operations reads the queue across
-- tenants. Both are operator-only surfaces.
CREATE TABLE IF NOT EXISTS ledger_dead_letters (
  id               TEXT PRIMARY KEY,
  tenant_hint      TEXT,
  producer         TEXT NOT NULL,
  event_key        TEXT,
  idempotency_key  TEXT,
  fingerprint      TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  error            TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 1,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_dead_letters_fingerprint
  ON ledger_dead_letters (producer, fingerprint);
CREATE INDEX IF NOT EXISTS ix_ledger_dead_letters_open
  ON ledger_dead_letters (resolved_at, last_seen);
CREATE INDEX IF NOT EXISTS ix_ledger_dead_letters_tenant
  ON ledger_dead_letters (tenant_hint, last_seen);

-- A dead letter's tenant, once known, is not re-pointed at another workspace.
CREATE TRIGGER IF NOT EXISTS ledger_dead_letters_tenant_immutable
BEFORE UPDATE OF tenant_hint ON ledger_dead_letters
WHEN OLD.tenant_hint IS NOT NULL AND NEW.tenant_hint IS NOT OLD.tenant_hint
BEGIN
  SELECT RAISE(ABORT, 'ledger_dead_letters.tenant_hint is immutable once set');
END;

-- ── ledger_reconciliation_runs ─────────────────────────────────────────────
-- kind      stage_replay | stripe_payments | tickets | ... (the reconcile job)
-- checked   how many entities were compared; deltas how many disagreed.
-- detail_json  ids and codes of the disagreeing entities, never PII.
CREATE TABLE IF NOT EXISTS ledger_reconciliation_runs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  checked      INTEGER NOT NULL DEFAULT 0,
  deltas       INTEGER NOT NULL DEFAULT 0,
  detail_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_ledger_reconciliation_runs
  ON ledger_reconciliation_runs (tenant_id, kind, started_at);

-- A row never changes tenant.
CREATE TRIGGER IF NOT EXISTS ledger_reconciliation_runs_tenant_immutable
BEFORE UPDATE OF tenant_id ON ledger_reconciliation_runs
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'ledger_reconciliation_runs.tenant_id is immutable');
END;
