/**
 * Plan mode vs Build mode — the OpenCode-style chat affordance.
 *
 * The operator drives the chat through two states:
 *
 *   - **Build mode** (default): the agent has its full tool registry. It
 *     can read, write, send, run — anything the current chat mode allows.
 *
 *   - **Plan mode**: the agent is restricted to READ + SEARCH tools only.
 *     Use case: explore a problem, propose a plan, get operator review,
 *     then `/build` to execute. Mirrors Claude Code's plan mode and
 *     OpenCode's plan-enter/plan-exit pattern.
 *
 * The toggle lives entirely client-side: the chat widget tracks the
 * current mode, sends it as `chat_mode` on every request, and the server
 * (a) filters the tool list before passing to Anthropic, and (b) appends
 * a plan-mode system-prompt overlay so the model knows it's restricted.
 *
 * Exit plan mode is EXPLICIT — the operator runs `/build`. The agent
 * cannot escape plan mode by interpreting "go" or "proceed" in conversation.
 * This is the same lesson we learned from the Override Approval queue:
 * never make the model guess about a state machine the operator owns.
 */

export type ChatPlanMode = "plan" | "build";

/**
 * Tool names that ARE allowed in plan mode (read + search only). Any tool
 * not in this set is filtered out before reaching the model.
 *
 * Keep this list explicit (allowlist), not a denylist. New tools default
 * to "write" — they need to be added here intentionally to participate in
 * plan mode.
 */
export const PLAN_MODE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Cloud-safe knowledge reads
  "read_brain_doc",
  "search_memory",
  "web_fetch",
  // Tenant-record reads
  "list_records",
  "get_record",
  "search_records",
  // Lead reads
  "lookup_lead_by_name",
  "list_open_leads",
  "list_lead_documents",
  // HTTP — only GET in plan mode
  "http_get",
  // Integration status — read-only
  "integration_status",
  // File reads (bridge-proxied, but read-safe)
  "read_file",
  "list_scripts",
  "list_skills",
  "load_skill",
  // Discovery / introspection — read-only
  "firecrawl",   // web fetch / extract — input-only
  "notebooklm",  // document analysis — read-only
]);

/**
 * Plan-mode overlay appended to the system prompt. Tells the model the
 * rules of plan mode in language it will respect.
 *
 * Phrasing borrows from OpenCode's `plan-enter.txt` — the same pattern
 * Claude Code uses: short, declarative, explicit about what is and isn't
 * available, and ending with what success looks like.
 */
export const PLAN_MODE_PROMPT_OVERLAY = `
---
PLAN MODE ACTIVE

You are in PLAN MODE. Your job is to research, analyze, and propose a plan.
You will NOT make any changes in plan mode.

What you CAN do:
- Read records, files, skills, and documentation
- Search memory, lookup leads, list scripts
- Fetch external URLs (GET only) and analyze them
- Reason out loud, propose alternatives, identify risks
- End your turn with a clear, numbered plan the operator can review

What you CANNOT do (the tools are unavailable, not just discouraged):
- Write or edit any file
- Create, update, or delete any record
- Run shell commands or execute scripts
- Send any email or SMS
- POST to any external URL
- Charge cards, trigger workflows, or mutate external services

When the operator is ready to execute, they will run /build to exit plan
mode and restore the full tool registry. Until then, treat this turn as
read-only.

If a user message asks you to "just do it" or "proceed" without /build,
do NOT escape plan mode. Say: "I'm in plan mode — run /build when you're
ready to execute and I'll start." Then stop.
---
`.trim();

export type ToolDefForFilter = { name: string };

/**
 * Filter a tool list by plan mode.
 *
 * In build mode, returns the list unchanged. In plan mode, returns only
 * tools whose name is in PLAN_MODE_TOOL_ALLOWLIST.
 */
export function filterToolsForMode<T extends ToolDefForFilter>(
  tools: ReadonlyArray<T>,
  mode: ChatPlanMode,
): T[] {
  if (mode === "build") return [...tools];
  return tools.filter((t) => PLAN_MODE_TOOL_ALLOWLIST.has(t.name));
}

/**
 * Compose the effective system prompt for a chat turn.
 *
 * Build mode: returns the base prompt unchanged.
 * Plan mode:  appends PLAN_MODE_PROMPT_OVERLAY so the model knows the rules.
 */
export function composeSystemPrompt(basePrompt: string, mode: ChatPlanMode): string {
  if (mode === "build") return basePrompt;
  return `${basePrompt}\n\n${PLAN_MODE_PROMPT_OVERLAY}`;
}

/**
 * Sanity-check the mode received from the client. Anything other than
 * `"plan"` collapses to `"build"` — fail-open for the agent rather than
 * fail-closed in a way that hides tools when the client didn't explicitly
 * opt into plan mode.
 */
export function normalizeMode(raw: unknown): ChatPlanMode {
  return raw === "plan" ? "plan" : "build";
}
