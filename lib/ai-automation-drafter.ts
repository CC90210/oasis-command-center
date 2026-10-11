/**
 * AI automation drafter — Claude generates a Python script + cron config
 * from a plain-English description.
 *
 * Phase 10.3 of the OASIS HQ redesign. CC's complaint: "I don't know how
 * easy it is to create a new automation — we may have to build a custom
 * Python script." This module lets him describe what he wants in plain
 * English; Claude returns a runnable script + the cron schedule + an
 * action_config block ready to insert into tenant_cron_jobs.
 *
 * The script is INSPECTABLE before it's saved. The operator reviews +
 * edits before clicking "Save automation". Nothing writes to disk
 * automatically — the next step (POST /api/automations/save-draft) is
 * what persists.
 *
 * Output shape:
 *   {
 *     suggested_name: "Daily Twitter cross-poster",
 *     suggested_description: "...",
 *     schedule: "0 9 * * *",
 *     schedule_human: "Daily at 09:00",
 *     script_filename: "twitter_cross_post.py",
 *     script_content: "#!/usr/bin/env python3\n...",
 *     agent_key: "maven",
 *     reasoning: "1-2 sentences explaining the design choices"
 *   }
 */

import { inferForTenant } from "./ai/infer";
import { isValidCronExpr } from "@/lib/automations/cron-grammar";

const MAX_TOKENS = 2400;

export interface AutomationDraft {
  suggested_name: string;
  suggested_description: string;
  schedule: string;
  schedule_human: string;
  script_filename: string;
  script_content: string;
  agent_key: string;
  reasoning: string;
}

export const SYSTEM_PROMPT = `You are Bravo, OASIS HQ's lead architect. Your job is to turn a one-paragraph operator description into a runnable Python automation: a script that lives in scripts/ + a cron entry that lives in cron_jobs.

The substrate you're writing for:
  - Python 3.12 on the operator's local Windows machine
  - Daemons run via PM2. The scheduler (bravo-scheduler) polls cron_jobs every 60s and fires due jobs as subprocesses.
  - Secrets live in .env.agents and are loaded via scripts/lib/secret_loader.py:load_env() — NEVER hardcode keys.
  - Database access: Turso (libSQL), not Supabase — Supabase is retired estate-wide. Query through the project's Turso tool (\`scripts/integrations/turso_tool.py\`); never import a \`supabase\` client.
  - Telegram alerts: \`from notify import notify; notify("message", category="system", force=True)\` ships to CC's Telegram.
  - Anthropic API: standard urllib.request with \`x-api-key: env["BRAVO_ANTHROPIC_API_KEY"]\` and \`anthropic-version: 2023-06-01\`.
  - Subprocess outputs: ALWAYS pass \`creationflags=WINDOWLESS_FLAGS\` so console windows don't pop up. Import: \`from _subprocess_helpers import WINDOWLESS_FLAGS\` (after sys.path.insert scripts/).

Script conventions:
  - First line shebang: \`#!/usr/bin/env python3\`
  - Docstring at top explaining what the automation does + cost (free / Claude per-run / etc.)
  - \`from __future__ import annotations\` if any modern type hints
  - sys.path setup: \`PROJECT_ROOT = Path(__file__).resolve().parent.parent; sys.path.insert(0, str(PROJECT_ROOT / "scripts"))\`
  - UTF-8 stdout: \`sys.stdout.reconfigure(encoding="utf-8", errors="replace")\` wrapped in try/except
  - Argparse for any flags, with a --dry-run option whenever the script does outbound side effects
  - Print a one-line summary at the end (e.g. "sent: 3 messages") so the scheduler logs something useful
  - No external pip installs — use the existing stdlib + the project's Turso tool + standard project deps
  - Be conservative on rate / cost — if the script calls Claude N times, hard-cap N at a sane default

Return ONLY a single JSON object on one line. Schema:
{
  "suggested_name": "<short title, <40 chars, for the cron row's name column>",
  "suggested_description": "<one sentence operator-facing description>",
  "schedule": "<5-field numeric cron expression, e.g. 0 9 * * 1-5>",
  "schedule_human": "<human-readable, e.g. 'Daily at 09:00'>",
  "script_filename": "<snake_case_name>.py",
  "script_content": "<the full Python script as a JSON-escaped string>",
  "agent_key": "<one of: bravo | atlas | maven | aura | solara — pick the agent whose domain this falls under>",
  "reasoning": "<1-2 sentences explaining your design choices>"
}

Schedule rules. The bridge's cron runner reads numeric cron only, and a draft whose schedule it cannot read is refused:
  - Five fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6).
  - Each field is *, */N, N, N-M, N-M/S, or a comma list of N, N-M or N-M/S.
  - Day of week as numbers 0-6 (0 = Sunday); never names like MON or MON-FRI. Weekdays are 1-5.
  - Month as numbers 1-12; never names like JAN.
  - No L, W, # or ?, and no @daily-style shortcuts.

NO markdown, NO code fence, NO prose outside the JSON. The script_content must be a valid JSON string (newlines as \\n).`;

export async function draftAutomation(
  description: string,
  opts: { tenantId: string | null },
): Promise<AutomationDraft> {
  const userPrompt =
    `Operator description:\n\n${description.trim()}\n\n` +
    `Generate the automation. Be specific about the cron schedule — if they said "every morning" pick 0 8 * * *, if "weekdays" pick 0 9 * * 1-5, if "weekly" pick a sensible day + time, etc.`;

  // Subscription, not the paid API. See lib/subscription-infer.ts.
  const inf = await inferForTenant(opts.tenantId, {
    source: "automation-drafter",
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTokens: MAX_TOKENS,
    modelTier: "smart",
  });
  if (!inf.ok) {
    throw new Error(inf.pending ? `drafter_pending: ${inf.error}` : `drafter_unavailable: ${inf.error}`);
  }
  const text = inf.text.trim();

  let cleaned = text;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  let parsed: Partial<AutomationDraft>;
  try {
    parsed = JSON.parse(cleaned) as Partial<AutomationDraft>;
  } catch {
    throw new Error(`automation_draft_parse_failed: ${text.slice(0, 300)}`);
  }

  const required: Array<keyof AutomationDraft> = [
    "suggested_name",
    "suggested_description",
    "schedule",
    "schedule_human",
    "script_filename",
    "script_content",
    "agent_key",
    "reasoning",
  ];
  for (const k of required) {
    if (typeof parsed[k] !== "string" || !(parsed[k] as string).trim()) {
      throw new Error(`automation_draft_missing_field: ${k}`);
    }
  }

  // Defense against pathological filenames — must be snake_case .py
  if (!/^[a-z][a-z0-9_]*\.py$/.test(parsed.script_filename!)) {
    throw new Error(`automation_draft_bad_filename: ${parsed.script_filename}`);
  }

  // The schedule must be one the bridge's cron runner can run: the same shared
  // grammar save-draft enforces (lib/automations/cron-grammar.ts). Unchecked
  // here, a draft with day names (0 9 * * MON-FRI) reached the read-only
  // review step and was then refused at Save. Refused here instead, the
  // operator is asked to draft again before being offered a Save that cannot
  // work. The schedule rides in the message (one line, bounded) so the route
  // can say what the AI wrote.
  if (!isValidCronExpr(parsed.schedule)) {
    const shown = parsed.schedule!.replace(/\s+/g, " ").trim().slice(0, 60);
    throw new Error(`automation_draft_bad_schedule: ${shown}`);
  }

  return parsed as AutomationDraft;
}
