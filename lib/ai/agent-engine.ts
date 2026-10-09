/**
 * lib/ai/agent-engine.ts - WHAT POWERS YOUR AGENTS, as one choice every screen
 * reads the same way (CC, 2026-10-09: "they should have the same background
 * workings ... you can use an API key, or you can use a CLI, either from a cloud
 * model or your local model").
 *
 * THE CHOICE. One per workspace, three kinds:
 *   api    the workspace's AI account (lib/ai/workspace-account.ts): a cloud
 *          provider's key (Anthropic, OpenAI, Google, OpenRouter) and its model.
 *          Every reply spends that account's API credits. This is the default:
 *          a workspace that never chose answers exactly as before.
 *   cli    an AI app on the paired computer (Claude Code, Codex, Gemini CLI),
 *          reached through the OASIS bridge the coding harness already uses.
 *          Replies run on that app's own sign-in on that computer (a
 *          subscription), not on API credits. Never a sign-in inside OASIS.
 *   local  a model served on the paired computer (Ollama or LM Studio),
 *          reached through the same bridge. No credits, no subscription.
 *
 * FALLBACK. A cli or local choice answers only when the paired computer can be
 * reached for the person asking (lib/ai/bridge-turn.ts). When it cannot, a
 * usable API account answers instead, and the reply says so ("via ... API"),
 * so a closed laptop never leaves the departments silent (the approved rule:
 * OASIS's own workspace runs on CC's CLI with an API key as fallback).
 *
 * THE ROW. agent_model_config, agent_key ENGINE_AGENT_KEY ("__engine__"),
 * user_id IS NULL: provider holds the kind ("cli" or "local"), model holds the
 * CLI or the local model's name. No row, or any other provider, is "api". It
 * holds no key (encrypted_api_key stays NULL), so no key-matching statement in
 * workspace-account.ts ever touches it, and the agent-config routes hide every
 * "__" row from the teammate list.
 *
 * PURE: no I/O, safe for client components.
 */

export const ENGINE_AGENT_KEY = "__engine__";

export const CLI_ENGINES = ["claude", "codex", "gemini"] as const;
export type CliEngine = (typeof CLI_ENGINES)[number];

export type AgentEngineChoice =
  | { kind: "api" }
  | { kind: "cli"; cli: CliEngine }
  | { kind: "local"; model: string };

export const CLI_ENGINE_LABEL: Record<CliEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
};

/** Whose money or plan a reply runs on. */
export type EngineSpend = "api_credits" | "cli_subscription" | "local_model" | "platform";

/** A local model name: what Ollama or LM Studio call it. Short, no spaces at the ends, no control characters. */
const LOCAL_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/;

export function isCliEngine(v: unknown): v is CliEngine {
  return typeof v === "string" && (CLI_ENGINES as readonly string[]).includes(v);
}

export function isLocalModelName(v: unknown): v is string {
  return typeof v === "string" && LOCAL_MODEL_RE.test(v);
}

/** The choice a stored row holds. Anything unreadable is the default, the API account. */
export function engineFromRow(row: { provider?: unknown; model?: unknown } | null | undefined): AgentEngineChoice {
  if (!row) return { kind: "api" };
  if (row.provider === "cli" && isCliEngine(row.model)) return { kind: "cli", cli: row.model };
  if (row.provider === "local" && isLocalModelName(row.model)) return { kind: "local", model: row.model };
  return { kind: "api" };
}

/** The row a choice is stored as (provider and model are NOT NULL columns). */
export function engineRow(choice: AgentEngineChoice): { provider: string; model: string } {
  if (choice.kind === "cli") return { provider: "cli", model: choice.cli };
  if (choice.kind === "local") return { provider: "local", model: choice.model };
  return { provider: "api", model: "-" };
}

/** A request body's choice, or null when it is not one. */
export function parseEngineChoice(raw: unknown): AgentEngineChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "api") return { kind: "api" };
  if (r.kind === "cli" && isCliEngine(r.cli)) return { kind: "cli", cli: r.cli };
  if (r.kind === "local" && typeof r.model === "string" && isLocalModelName(r.model.trim())) {
    return { kind: "local", model: r.model.trim() };
  }
  return null;
}

/** "Claude Code on your paired computer": the words for a choice that is not the API account. */
export function bridgeEngineLine(choice: Exclude<AgentEngineChoice, { kind: "api" }>): string {
  return choice.kind === "cli"
    ? `${CLI_ENGINE_LABEL[choice.cli]} on your paired computer`
    : `${choice.model} (local model) on your paired computer`;
}

/**
 * What answered a department turn on the paired computer, harness included:
 * "Codex in the Marketing harness on your paired computer". A local model
 * answers through the bridge's model server, not in a harness folder.
 */
export function harnessEngineLine(choice: Exclude<AgentEngineChoice, { kind: "api" }>, harnessLabel: string): string {
  return choice.kind === "cli" ? `${CLI_ENGINE_LABEL[choice.cli]} in the ${harnessLabel} harness on your paired computer` : bridgeEngineLine(choice);
}

/**
 * The coding harness's route, read from the SAME choice (CC, 2026-10-09: "the
 * coding harness and the department agents should share the same connection
 * ... on the same functionality"). There is no second picker: an app on the
 * paired computer runs the harness on that app; an AI account runs it on the
 * cloud API. A local model cannot edit files, so the harness then runs on
 * Claude Code on the same computer, and says so.
 */
export function harnessRouteFor(choice: AgentEngineChoice): { mode: "cli" | "cloud_only"; runtime: CliEngine; note: string | null } {
  if (choice.kind === "cli") return { mode: "cli", runtime: choice.cli, note: null };
  if (choice.kind === "local") {
    return { mode: "cli", runtime: "claude", note: "Your agents use a local model; the coding harness edits files, so it runs on Claude Code on the same computer." };
  }
  return { mode: "cloud_only", runtime: "claude", note: null };
}

/**
 * The code a turn leaves in ai_usage_events.fallback_reason when the chosen
 * engine could not answer and the API account did: `engine_unreachable:claude`
 * (or codex, gemini, local). A code, never prose; lib/health/department-chat-
 * checks.ts reads it back into words, so keep the two in step.
 */
export const ENGINE_FALLBACK_PREFIX = "engine_unreachable:";
export function engineFallbackReason(choice: Exclude<AgentEngineChoice, { kind: "api" }>): string {
  return `${ENGINE_FALLBACK_PREFIX}${choice.kind === "cli" ? choice.cli : "local"}`;
}

/** "Agents: ..." in the coding harness header: the choice in a few words. */
export function agentsEngineLine(choice: AgentEngineChoice): string {
  return choice.kind === "api" ? "your AI account (API credits)" : bridgeEngineLine(choice);
}

export function spendFor(choice: AgentEngineChoice): EngineSpend {
  return choice.kind === "cli" ? "cli_subscription" : choice.kind === "local" ? "local_model" : "api_credits";
}

/** One plain sentence on what a reply costs, for the channel header and AI brain. */
export function spendSentence(spend: EngineSpend): string {
  switch (spend) {
    case "cli_subscription":
      return "Replies run on the app's own sign-in on your paired computer. No API credits are spent.";
    case "local_model":
      return "Replies run on a model on your paired computer. No API credits are spent.";
    case "platform":
      return "Replies run on the OASIS platform key.";
    default:
      return "Each reply spends API credits on the connected AI account.";
  }
}

/** Short tag for a reply's footer: "API credits", "subscription", "local". */
export function spendTag(spend: EngineSpend): string {
  switch (spend) {
    case "cli_subscription":
      return "subscription, no API credits";
    case "local_model":
      return "local model, no API credits";
    case "platform":
      return "OASIS platform key";
    default:
      return "API credits";
  }
}

export function isEngineSpend(v: unknown): v is EngineSpend {
  return v === "api_credits" || v === "cli_subscription" || v === "local_model" || v === "platform";
}

/**
 * What a chat header says powers it: the line ("Claude Code on your paired
 * computer"), whose credits or plan it spends, and a note when the chosen
 * engine can't be reached and something else answers in its place.
 */
export type EngineLabel = { line: string; spend: EngineSpend; note: string | null };

/** Where every "what powers this" label links: Settings > AI brain, at the engine choice. */
export const ENGINE_SETTINGS_HREF = "/settings/ai#engine";
