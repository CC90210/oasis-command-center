/**
 * tests/ai-automation-drafter-prompt.test.ts
 *
 * BUG 3 (2026-10-10): lib/ai-automation-drafter.ts's SYSTEM_PROMPT told the
 * drafting model the stack uses Supabase (`from supabase import
 * create_client; sb = create_client(env["BRAVO_SUPABASE_URL"], ...)`).
 * Supabase is retired estate-wide; the data layer is Turso (libSQL). A
 * model following this prompt would draft a new automation script against
 * a database that no longer exists.
 *
 * This pins that the false claim is gone and the real backend is named,
 * while every other fact the prompt gives the model (the real substrate:
 * Windows, PM2, the scheduler, secrets loading, Telegram, Anthropic,
 * windowless subprocesses, the output schema) survives untouched — the fix
 * corrects only what was false, it does not redesign the prompt.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-automation-drafter-prompt.test.ts
 */
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "../lib/ai-automation-drafter";

// The prompt may still SAY "Supabase" to actively warn the model away from
// it (far more robust than silent omission, which a model could fill back
// in from training-data defaults) — what must be gone is any INSTRUCTION
// to use it: the old access pattern and its Supabase-shaped env var names.
assert.ok(
  !/from supabase import create_client/i.test(SYSTEM_PROMPT),
  "the drafting prompt must not instruct the model to use the supabase client",
);
assert.ok(
  !/BRAVO_SUPABASE_URL|BRAVO_SUPABASE_SERVICE_ROLE_KEY/.test(SYSTEM_PROMPT),
  "the drafting prompt must not hand the model Supabase-shaped env var names",
);
assert.match(
  SYSTEM_PROMPT,
  /turso/i,
  "the drafting prompt must name the real database (Turso/libSQL)",
);
assert.match(
  SYSTEM_PROMPT,
  /not Supabase/i,
  "the prompt should actively warn the model away from the retired backend, not just omit it",
);

// Facts the fix must leave alone.
assert.match(SYSTEM_PROMPT, /Python 3\.12 on the operator's local Windows machine/);
assert.match(SYSTEM_PROMPT, /PM2/);
assert.match(SYSTEM_PROMPT, /cron_jobs/);
assert.match(SYSTEM_PROMPT, /secret_loader\.py:load_env\(\)/);
assert.match(SYSTEM_PROMPT, /notify\("message", category="system", force=True\)/);
assert.match(SYSTEM_PROMPT, /WINDOWLESS_FLAGS/);
assert.match(SYSTEM_PROMPT, /"agent_key": "<one of: bravo \| atlas \| maven \| aura \| solara/);

console.log("ai-automation-drafter-prompt.test.ts: OK");
