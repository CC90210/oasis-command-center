-- bravo__192_ai_usage.sql - the AI usage ledger and monthly AI budgets (OASIS OS
-- plan v2 §F2.6, docs/os-revamp/03-connectors-ai-finance.md §d.3, 2026-09-29).
--
-- WHAT THIS IS. Before this, nothing metered a model call: 16 lifetime chat
-- sessions recorded $0, and /api/chat guessed a cost from a hardcoded price
-- table that was already wrong. The department agents (F5) must be metered and
-- capped before they ship.
--
--   ai_usage_events    one row per model call, on every path that calls a model
--                      (lib/ai/usage.ts is the only writer; the lint gate
--                      tests/ai-usage-no-unmetered-calls.test.ts fails on any
--                      provider call that does not go through it).
--   model_prices       effective-dated list prices, seeded below ONLY with
--                      prices read on the provider's own pricing page, with the
--                      page and the day it was read. A model with no row is
--                      recorded with cost_micro_usd NULL ("unknown"), never a
--                      guessed number.
--   tenant_ai_budgets  one row per tenant per month. A call reserves its worst
--                      case before it is sent and settles to its real cost after;
--                      a call that would pass the cap is refused (HTTP 402). A
--                      cap STANDS until it is changed: a month with no row of its
--                      own takes the cap of the tenant's latest earlier row. A
--                      tenant with no row at all, or whose latest cap is NULL,
--                      has no cap.
--
-- CONVENTIONS (binding, from bravo__186/190):
--   - tenant_id TEXT NOT NULL on every tenant table, every tenant index LEADS
--     with tenant_id, and a row never changes tenant (triggers below). libSQL has
--     no row-level security: the WHERE in lib/ai/usage.ts is the boundary.
--   - ids are ULIDs written by the app (lib/ledger/emit.ts newLedgerId), so ids
--     sort in time order. Timestamps are ISO-8601 UTC strings from the app.
--   - Money is INTEGER micro-USD (1 USD = 1,000,000). Prices are micro-USD per
--     million tokens, so $3 / MTok is 3000000.
--   - NO CHECK constraints on the vocabularies (surface, auth_kind,
--     billing_mode, outcome). They live once, in lib/ai/usage.ts, and
--     tests/ai-usage-ledger.test.ts pins them. Numeric sanity checks are fine.
--   - Additive only. Nothing here drops or rewrites an existing object.
--
-- Not applied by the author: the lead applies it to production BEFORE the code
-- that ships with it is deployed. Until it is, every model call logs
-- ai_usage_ledger_not_installed and runs uncapped and unrecorded (a table that
-- does not exist holds no cap). Once it is, a budget that cannot be read fails
-- the call closed (ai_usage_unavailable): a cap that cannot be read cannot be
-- enforced.

-- ── ai_usage_events ────────────────────────────────────────────────────────
-- occurred_at     when the call was dispatched (server UTC, ms).
-- provider/model  what was asked for (the id sent, not a display name).
-- surface         the code path that made the call (lib/ai/usage.ts
--                 USAGE_SURFACES, or infer:<source> for the subscription router).
-- auth_kind       api_key | oauth | subscription | local | managed
-- billing_mode    byo_key (the tenant's own key) | platform (OASIS's platform key,
--                 verified operator only) | managed (OASIS's managed workspace
--                 key, billed to the tenant) | subscription (a flat plan) |
--                 local (the tenant's own model server)
-- department_key / job_id / session_id / teammate_id / user_id
--                 who and what the call served, when known. teammate_id is the
--                 AI teammate's key or slug, user_id the signed-in person.
-- attempt_no / fallback_reason
--                 1 for a first attempt; a later attempt of the same logical
--                 call says why it moved (never a silent downgrade).
-- *_tokens        as the provider reported them; NULL when it reported none.
--                 input_tokens is UNCACHED input (billed at the base rate):
--                 cache reads and cache writes are their own columns.
-- cost_micro_usd  NULL when unknown: no price row, a price with no rate for a
--                 token kind the call used, or a call that broke off before the
--                 provider reported its usage.
-- cost_source     price_table | provider_reported (OpenRouter's usage.cost) |
--                 none (nothing was billed: refused before sending, or the
--                 provider answered non-2xx) | NULL (unknown)
-- reserved_micro_usd  the reservation this call held against the month's cap;
--                 NULL when the tenant had no cap.
-- outcome         ok | error | refused | timeout | cancelled, how the call ended;
--                 or, for a call that holds a reservation:
--                 pending  written with the reservation, before the call is
--                          sent, so no reservation exists without a row;
--                 expired  its end was never recorded (the Worker was cancelled,
--                          or the write failed) and expires_at passed: the next
--                          reservation for the tenant settled it at the
--                          reservation, so an unknown only over-counts.
-- expires_at      a pending row's deadline (NULL on every other row).
-- error_code      a code, never provider prose (provider_401, stream_failed,
--                 ai_budget_exhausted, managed_runtime_not_configured,
--                 reservation_expired, ...).
-- job_id          for the subscription router, the inference_jobs id: ONE row
--                 per job however many calls wait on it (a timed-out row is
--                 resolved by the call that later sees the job finish).
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  occurred_at         TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  surface             TEXT NOT NULL,
  auth_kind           TEXT NOT NULL,
  billing_mode        TEXT NOT NULL,
  department_key      TEXT,
  job_id              TEXT,
  session_id          TEXT,
  teammate_id         TEXT,
  user_id             TEXT,
  attempt_no          INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  fallback_reason     TEXT,
  input_tokens        INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens   INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens  INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_micro_usd      INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  cost_source         TEXT,
  reserved_micro_usd  INTEGER CHECK (reserved_micro_usd IS NULL OR reserved_micro_usd >= 0),
  latency_ms          INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  outcome             TEXT NOT NULL,
  error_code          TEXT,
  expires_at          TEXT
);
-- usageFor (lib/ai/usage.ts): one tenant's month.
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_tenant_time
  ON ai_usage_events (tenant_id, occurred_at);
-- Spend by department, and by the code path that spent it.
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_tenant_dept
  ON ai_usage_events (tenant_id, department_key, occurred_at);
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_tenant_surface
  ON ai_usage_events (tenant_id, surface, occurred_at);
-- The expiry sweep every reservation runs first (lib/ai/usage.ts): only the
-- reservations still in flight, so it stays small however long the ledger grows.
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_tenant_pending
  ON ai_usage_events (tenant_id, expires_at) WHERE outcome = 'pending';
-- One row per subscription-router job (lib/ai/usage.ts recordJobModelCall).
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_tenant_job
  ON ai_usage_events (tenant_id, job_id) WHERE job_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS ai_usage_events_tenant_immutable
BEFORE UPDATE OF tenant_id ON ai_usage_events
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'ai_usage_events.tenant_id is immutable');
END;

-- ── model_prices ───────────────────────────────────────────────────────────
-- Not tenant data: one list price per (provider, model), effective-dated.
-- effective_from      the first moment the row applies (ISO-8601 UTC). A call
--                     uses the newest row with effective_from <= its occurred_at.
-- input_tokens_above  a tier: the row applies to a call whose whole prompt
--                     (uncached + cache read + cache write tokens) is ABOVE this
--                     many tokens. 0 is the base tier. OpenAI prices gpt-5.4 and
--                     Google prices gemini-2.5-pro higher for long prompts.
-- *_micro_usd_per_mtok  micro-USD per million tokens. cache_read / cache_write
--                     are NULL where the page lists no such rate; a call that
--                     used that token kind then records cost NULL, not zero.
--                     cache_write is the 5-minute cache-write rate (no call in
--                     this repo asks for the 1-hour cache).
-- source_url / source_fetched_on  the provider's own pricing page and the UTC
--                     day it was read. Both NOT NULL: a price nobody can trace
--                     is not a price.
CREATE TABLE IF NOT EXISTS model_prices (
  provider                        TEXT NOT NULL,
  model                           TEXT NOT NULL,
  effective_from                  TEXT NOT NULL,
  input_tokens_above              INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens_above >= 0),
  input_micro_usd_per_mtok        INTEGER NOT NULL CHECK (input_micro_usd_per_mtok >= 0),
  output_micro_usd_per_mtok       INTEGER NOT NULL CHECK (output_micro_usd_per_mtok >= 0),
  cache_read_micro_usd_per_mtok   INTEGER CHECK (cache_read_micro_usd_per_mtok IS NULL OR cache_read_micro_usd_per_mtok >= 0),
  cache_write_micro_usd_per_mtok  INTEGER CHECK (cache_write_micro_usd_per_mtok IS NULL OR cache_write_micro_usd_per_mtok >= 0),
  source_url                      TEXT NOT NULL,
  source_fetched_on               TEXT NOT NULL,
  PRIMARY KEY (provider, model, effective_from, input_tokens_above)
);

-- ── tenant_ai_budgets ──────────────────────────────────────────────────────
-- period_month   'YYYY-MM', the UTC month of the call's occurred_at.
-- cap_micro_usd  the hard cap for the month. It carries forward: the first
--                reservation in a month with no row writes the month's row with
--                the latest earlier cap, so a cap never lapses at 00:00 UTC on
--                the 1st. NULL lifts the cap from this month on.
-- reserved_micro_usd  worst-case cost of calls in flight (reserve before, settle
--                after: lib/ai/usage.ts reserveBudget and the call's finish).
--                Every reservation has its pending ai_usage_events row, written
--                in the same transaction.
-- spent_micro_usd     settled cost. A call whose real cost is unknown (or whose
--                end was never recorded) settles at its reservation, so an
--                unknown can only over-count, never let spend slip past the cap.
CREATE TABLE IF NOT EXISTS tenant_ai_budgets (
  tenant_id           TEXT NOT NULL,
  period_month        TEXT NOT NULL,
  cap_micro_usd       INTEGER CHECK (cap_micro_usd IS NULL OR cap_micro_usd >= 0),
  reserved_micro_usd  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  spent_micro_usd     INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, period_month)
);

CREATE TRIGGER IF NOT EXISTS tenant_ai_budgets_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_ai_budgets
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_ai_budgets.tenant_id is immutable');
END;

-- ── model_prices seed ──────────────────────────────────────────────────────
-- Every row was read on 2026-09-29 from the page in its source_url. Only the
-- models this repo actually sends are listed (lib/providers.ts
-- PROVIDER_REGISTRY, lib/operator-credentials.ts, lib/agents/provider-probe.ts
-- PROBE_MODEL, lib/ai-document-extractor.ts). NOT seeded, so recorded with cost
-- NULL until someone reads and adds a price: every OpenRouter model (OpenRouter
-- reports each call's cost itself in usage.cost, which is recorded as
-- provider_reported), and every Ollama / LM Studio model (the tenant's own
-- machine; billing_mode local).
-- effective_from is the day the price was read, not the day the provider set
-- it: the ledger holds no call older than that.
-- INSERT OR IGNORE: re-running this file never rewrites a price.

-- Anthropic, https://platform.claude.com/docs/en/about-claude/pricing
-- (global routing, no inference_geo, 5-minute cache writes).
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('anthropic', 'claude-opus-4-7',   '2026-09-29T00:00:00.000Z', 0, 5000000, 25000000, 500000, 6250000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-29'),
  ('anthropic', 'claude-sonnet-4-6', '2026-09-29T00:00:00.000Z', 0, 3000000, 15000000, 300000, 3750000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-29'),
  ('anthropic', 'claude-haiku-4-5',  '2026-09-29T00:00:00.000Z', 0, 1000000,  5000000, 100000, 1250000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-29');

-- OpenAI, https://developers.openai.com/api/docs/pricing (Standard tier). The
-- page lists no cache-write rate. gpt-5.4 has a long-context tier: "Short
-- context: <=272K input tokens. Long context: >272K input tokens."
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('openai', 'gpt-5.4',       '2026-09-29T00:00:00.000Z', 0,      2500000, 15000000, 250000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-09-29'),
  ('openai', 'gpt-5.4',       '2026-09-29T00:00:00.000Z', 272000, 5000000, 22500000, 500000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-09-29'),
  ('openai', 'gpt-5.4-mini',  '2026-09-29T00:00:00.000Z', 0,       750000,  4500000,  75000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-09-29'),
  ('openai', 'gpt-5.2',       '2026-09-29T00:00:00.000Z', 0,      1750000, 14000000, 175000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-09-29'),
  ('openai', 'gpt-5.3-codex', '2026-09-29T00:00:00.000Z', 0,      1750000, 14000000, 175000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-09-29');

-- Google, https://ai.google.dev/gemini-api/docs/pricing (paid tier, Standard,
-- text input; output includes thinking tokens). The context-caching rate is the
-- cache-read rate; the page lists storage per hour, not a per-token write rate.
-- gemini-2.5-pro is priced higher for prompts over 200k tokens.
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('google', 'gemini-2.5-pro',   '2026-09-29T00:00:00.000Z', 0,      1250000, 10000000, 125000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-09-29'),
  ('google', 'gemini-2.5-pro',   '2026-09-29T00:00:00.000Z', 200000, 2500000, 15000000, 250000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-09-29'),
  ('google', 'gemini-2.5-flash', '2026-09-29T00:00:00.000Z', 0,       300000,  2500000,  30000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-09-29');
