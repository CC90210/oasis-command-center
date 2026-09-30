/**
 * Single source of truth for AI prompts used by the dashboard
 * (lib/ai-*.ts). Each prompt lives in its own .txt file in this directory.
 *
 * The .txt files are compiled into ./generated.ts by
 * scripts/gen-content-modules.mjs (run by `prebuild`, committed, and checked
 * for drift by tests/playbook-docs.test.ts). This module used to
 * readFileSync them at module init, which works on every local runtime and
 * throws on the production Worker: workerd has no filesystem, and the file
 * tracer copying a .txt into .open-next/ does not put it in the bundle
 * wrangler uploads. The scoring and check-in routes under /api/leads/[id]
 * would have thrown the first time anything exercised them.
 *
 * The Python cron scripts in the Business-Empire-Agent repo
 * (scripts/auto_score_leads.py and friends) need their own copy of these
 * prompts — they used to read this directory directly when the dashboard
 * was a subfolder of that repo. Sync prompt edits across both repos until
 * the Python side fetches from a shared store.
 *
 * Also shared: the INCLUDED_FIELDS allowlist for which lead-data keys
 * Claude should weight against. Same problem (duplication between TS
 * and Python), same fix (declared here, mirrored as JSON for Python).
 */

import { PROMPT_SOURCES } from "./generated";

function loadPrompt(filename: string): string {
  const text = PROMPT_SOURCES[filename];
  if (typeof text !== "string") {
    throw new Error(
      `prompts/${filename} is not in lib/prompts/generated.ts. Run node scripts/gen-content-modules.mjs.`,
    );
  }
  return text.trim();
}

export const OASIS_LEAD_SCORING_PROMPT = loadPrompt("oasis-lead-scoring.txt");

/**
 * System prompt for the per-lead check-in email composer
 * (POST /api/leads/[id]/compose-checkin). Lives next to oasis-lead-scoring
 * so future prompt edits keep the canonical AI surface area in one
 * directory + show up in git diffs as plain-text changes.
 */
export const OASIS_CHECKIN_COMPOSE_PROMPT = loadPrompt("oasis-checkin-compose.txt");

/**
 * Fields Claude is allowed to weight when scoring a lead. Keep this in
 * lockstep with scripts/auto_score_leads.py:INCLUDED_FIELDS — the JSON
 * mirror file is at lib/prompts/included-fields.json which Python reads.
 */
export const LEAD_SCORING_INCLUDED_FIELDS = [
  "name", "company", "email", "phone", "source", "stage",
  "score", "value_estimate", "last_contacted_at", "notes",
  "title", "role",
] as const;
