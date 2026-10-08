-- bravo__204_model_prices_current.sql
--
-- Prices for every model the app now offers (lib/ai/model-registry.ts), so a
-- call on one of them records its cost instead of "unknown", and a workspace
-- with a monthly AI budget can run it (lib/ai/usage.ts refuses a capped call
-- on a model with no verified price: ai_budget_unpriced_model).
--
-- WHY. bravo__192 priced only the models the app sent on 2026-09-29. On
-- 2026-10-08 OASIS's departments moved to gemini-3.8-flash (Google now serves
-- gemini-2.5-pro only to projects that used it before), and every call on it
-- recorded cost NULL. The registry now offers each provider's current models.
--
-- WHAT. ADDITIVE ONLY: INSERT OR IGNORE of new (provider, model,
-- effective_from, input_tokens_above) rows. No row bravo__192 wrote is
-- touched, and re-running this file never rewrites a price. The code works
-- before and after it runs: before, these models record cost NULL, as today.
--
-- SOURCES. Every number was read on 2026-10-08 from the page in its
-- source_url (the research behind lib/ai/model-registry.ts quotes each one);
-- tests/ai-model-registry.test.ts pins every row equal to the registry's
-- `prices`, and checks that every model the pickers offer has one.
--   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
--              (global routing; cache_write is the 5-minute write, 1.25x input;
--              Claude Haiku 5.5 costs more for prompts above 100K tokens)
--   OpenAI     https://developers.openai.com/api/docs/pricing (Standard tier;
--              the page lists no cache-write rate; prompts above 272K input
--              tokens cost 2x input and cache and 1.5x output on the models it
--              says so for)
--   Google     https://ai.google.dev/gemini-api/docs/pricing (paid tier,
--              Standard; the context-caching rate is the cache-read rate; 3.1
--              Pro costs more above 200K prompt tokens; Gemini 3.8 Flash is at
--              an introductory price through 2026-12-31 and doubles on
--              2027-01-01, which is its own dated row below)
--   OpenRouter https://openrouter.ai/api/v1/models (its live catalog: the top
--              provider's list price, per token, here per million). OpenRouter
--              also reports each call's own cost (usage.cost), which the
--              ledger records first; these rows are what a budget reserves
--              against. OpenRouter publishes no dated change for Gemini 3.8
--              Flash, so none is assumed here.
-- effective_from is the day the price was read, except a dated change the
-- provider's page prints (2027-01-01).
--
-- Units: micro-USD per million tokens (USD x 1,000,000), as bravo__192.

-- Anthropic
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('anthropic', 'claude-sonnet-5-5', '2026-10-08T00:00:00.000Z', 0,      2000000, 10000000, 100000,  2500000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-08'),
  ('anthropic', 'claude-haiku-5-5',  '2026-10-08T00:00:00.000Z', 0,       100000,   500000,  10000,   125000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-08'),
  ('anthropic', 'claude-haiku-5-5',  '2026-10-08T00:00:00.000Z', 100000,  500000,  2500000,  50000,   625000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-08'),
  ('anthropic', 'claude-opus-5-5',   '2026-10-08T00:00:00.000Z', 0,      4000000, 20000000, 200000,  5000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-08'),
  ('anthropic', 'claude-fable-5-1',  '2026-10-08T00:00:00.000Z', 0,     10000000, 50000000, 250000, 12500000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-08');

-- OpenAI
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('openai', 'gpt-5.6-terra', '2026-10-08T00:00:00.000Z', 0,      2000000, 12000000, 200000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-10-08'),
  ('openai', 'gpt-5.6-terra', '2026-10-08T00:00:00.000Z', 272000, 4000000, 18000000, 400000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-10-08'),
  ('openai', 'gpt-5.6-luna',  '2026-10-08T00:00:00.000Z', 0,       200000,  1200000,  20000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-10-08'),
  ('openai', 'gpt-5.6-luna',  '2026-10-08T00:00:00.000Z', 272000,  400000,  1800000,  40000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-10-08'),
  ('openai', 'gpt-5.5',       '2026-10-08T00:00:00.000Z', 0,      5000000, 30000000, 500000, NULL,
   'https://developers.openai.com/api/docs/pricing', '2026-10-08');

-- Google
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('google', 'gemini-3.8-flash',       '2026-10-08T00:00:00.000Z', 0,       750000,  3750000,  75000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-10-08'),
  ('google', 'gemini-3.8-flash',       '2027-01-01T00:00:00.000Z', 0,      1500000,  7500000, 150000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-10-08'),
  ('google', 'gemini-3.5-flash-lite',  '2026-10-08T00:00:00.000Z', 0,       300000,  2500000,  30000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-10-08'),
  ('google', 'gemini-3.1-pro-preview', '2026-10-08T00:00:00.000Z', 0,      2000000, 12000000, 200000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-10-08'),
  ('google', 'gemini-3.1-pro-preview', '2026-10-08T00:00:00.000Z', 200000, 4000000, 18000000, 400000, NULL,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-10-08');

-- OpenRouter
INSERT OR IGNORE INTO model_prices
  (provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok, output_micro_usd_per_mtok,
   cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url, source_fetched_on)
VALUES
  ('openrouter', 'anthropic/claude-sonnet-5.5',       '2026-10-08T00:00:00.000Z', 0,  2000000, 10000000, 100000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'anthropic/claude-haiku-5.5',        '2026-10-08T00:00:00.000Z', 0,   100000,   500000,  10000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'anthropic/claude-opus-5.5',         '2026-10-08T00:00:00.000Z', 0,  4000000, 20000000, 200000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'anthropic/claude-fable-5.1',        '2026-10-08T00:00:00.000Z', 0, 10000000, 50000000, 250000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'google/gemini-3.8-flash',           '2026-10-08T00:00:00.000Z', 0,   750000,  3750000,  75000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'google/gemini-3.5-flash-lite',      '2026-10-08T00:00:00.000Z', 0,   300000,  2500000,  30000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'google/gemini-3.1-pro-preview',     '2026-10-08T00:00:00.000Z', 0,  2000000, 12000000, 200000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'openai/gpt-5.4',                    '2026-10-08T00:00:00.000Z', 0,  2500000, 15000000, 250000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'openai/gpt-5.4-mini',               '2026-10-08T00:00:00.000Z', 0,   750000,  4500000,  75000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'meta-llama/llama-4-maverick',       '2026-10-08T00:00:00.000Z', 0,   187500,   652500,  50000, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08'),
  ('openrouter', 'meta-llama/llama-3.3-70b-instruct', '2026-10-08T00:00:00.000Z', 0,   100000,   320000,   NULL, NULL,
   'https://openrouter.ai/api/v1/models', '2026-10-08');
