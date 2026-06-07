/**
 * Single source of truth for AI prompts used by the dashboard
 * (lib/ai-*.ts). Each prompt lives in its own .txt file in this directory.
 *
 * This module reads at process startup via fs.readFileSync and exports
 * the string. Next.js's outputFileTracing picks up the .txt file at build
 * time so the bundle on Vercel includes them.
 *
 * The Python cron scripts in the Business-Empire-Agent repo
 * (scripts/auto_score_leads.py and friends) need their own copy of these
 * prompts — they used to read this directory directly when the dashboard
 * was a subfolder of that repo. Sync prompt edits across both repos until
 * the Python side fetches from a shared store.
 *
 * Editing only one runtime's copy now means git status flags the diff.
 * Prior pattern (literal duplicate string in two files with a "Keep in
 * lockstep" comment) was wishful — this is the structural fix.
 *
 * Also shared: the INCLUDED_FIELDS allowlist for which lead-data keys
 * Claude should weight against. Same problem (duplication between TS
 * and Python), same fix (declared here, mirrored as JSON for Python).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS_DIR = join(process.cwd(), "lib", "prompts");

function loadPrompt(filename: string): string {
  try {
    return readFileSync(join(PROMPTS_DIR, filename), "utf-8").trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `prompts/${filename} not found at module init — Next.js bundling missed the file. ${message}`,
    );
  }
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
