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
 * FALLBACK. A subscription or local choice defaults to no fallback. The user
 * can explicitly opt in to workspace_api; only then may an unreachable target
 * use the workspace API account, and both the reply and audit trail say so.
 *
 * THE ROW. agent_model_config, agent_key ENGINE_AGENT_KEY ("__engine__"). A
 * NULL user_id is the workspace default; a user id is that person's override.
 * Subscription/local rows also bind computer_pairing_id and fallback_policy.
 * Deleting the personal row means "use workspace default"; inheritance is not
 * a fourth engine. Engine rows hold no key (encrypted_api_key stays NULL).
 *
 * PURE: no I/O, safe for client components.
 */

export const ENGINE_AGENT_KEY = "__engine__";

export const CLI_ENGINES = ["claude", "codex", "gemini"] as const;
export type CliEngine = (typeof CLI_ENGINES)[number];

export const API_ENGINE_PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;
export type ApiEngineProvider = (typeof API_ENGINE_PROVIDERS)[number];
export const ENGINE_FALLBACKS = ["none", "workspace_api"] as const;
export type EngineFallback = (typeof ENGINE_FALLBACKS)[number];

/**
 * The browser/API contract. Device-backed choices always name the exact
 * pairing that Test, Connect, Save and real work must use.
 */
export type EngineSelection =
  | { mode: "subscription"; pairingId: string; provider: CliEngine; fallback: EngineFallback }
  | { mode: "local"; pairingId: string; modelRef: string; fallback: EngineFallback }
  | { mode: "api"; provider: ApiEngineProvider };

export type AgentEngineChoice =
  | { kind: "api"; provider?: ApiEngineProvider }
  | { kind: "cli"; cli: CliEngine; pairingId?: string; fallback?: EngineFallback }
  | { kind: "local"; model: string; pairingId?: string; fallback?: EngineFallback };

export const CLI_ENGINE_LABEL: Record<CliEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
};

/** Whose money or plan a reply runs on. */
export type EngineSpend = "api_credits" | "cli_subscription" | "local_model" | "platform";

/** A local model name: what Ollama or LM Studio call it. Short, no spaces at the ends, no control characters. */
const LOCAL_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/;
const LOCAL_MODEL_REF_RE = /^(?:ollama|lmstudio)\/[A-Za-z0-9][A-Za-z0-9._:\/-]{0,111}$/;
const PAIRING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isCliEngine(v: unknown): v is CliEngine {
  return typeof v === "string" && (CLI_ENGINES as readonly string[]).includes(v);
}

export function isApiEngineProvider(v: unknown): v is ApiEngineProvider {
  return typeof v === "string" && (API_ENGINE_PROVIDERS as readonly string[]).includes(v);
}

export function isEngineFallback(v: unknown): v is EngineFallback {
  return typeof v === "string" && (ENGINE_FALLBACKS as readonly string[]).includes(v);
}

export function isPairingId(v: unknown): v is string {
  return typeof v === "string" && PAIRING_ID_RE.test(v);
}

export function isLocalModelName(v: unknown): v is string {
  return typeof v === "string" && LOCAL_MODEL_RE.test(v);
}

/** The choice a stored row holds. Anything unreadable is the default, the API account. */
export function engineFromRow(
  row:
    | { provider?: unknown; model?: unknown; computer_pairing_id?: unknown; fallback_policy?: unknown }
    | null
    | undefined,
): AgentEngineChoice {
  if (!row) return { kind: "api" };
  const pairingId = isPairingId(row.computer_pairing_id) ? row.computer_pairing_id : undefined;
  const fallback = isEngineFallback(row.fallback_policy) ? row.fallback_policy : undefined;
  if (row.provider === "cli" && isCliEngine(row.model)) {
    return { kind: "cli", cli: row.model, ...(pairingId ? { pairingId } : {}), ...(fallback ? { fallback } : {}) };
  }
  if (row.provider === "local" && isLocalModelName(row.model)) {
    return { kind: "local", model: row.model, ...(pairingId ? { pairingId } : {}), ...(fallback ? { fallback } : {}) };
  }
  if (row.provider === "api") {
    return { kind: "api", ...(isApiEngineProvider(row.model) ? { provider: row.model } : {}) };
  }
  return { kind: "api" };
}

/** The row a choice is stored as (provider and model are NOT NULL columns). */
export function engineRow(choice: AgentEngineChoice): {
  provider: string;
  model: string;
  computerPairingId: string | null;
  fallbackPolicy: EngineFallback;
} {
  if (choice.kind === "cli") {
    return { provider: "cli", model: choice.cli, computerPairingId: choice.pairingId ?? null, fallbackPolicy: choice.fallback ?? "none" };
  }
  if (choice.kind === "local") {
    return { provider: "local", model: choice.model, computerPairingId: choice.pairingId ?? null, fallbackPolicy: choice.fallback ?? "none" };
  }
  return { provider: "api", model: choice.provider ?? "-", computerPairingId: null, fallbackPolicy: "none" };
}

/** Strict new browser/API shape. Legacy shapes are accepted only by parseEngineChoice. */
export function parseEngineSelection(raw: unknown): EngineSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === "subscription" && isPairingId(r.pairingId) && isCliEngine(r.provider) && isEngineFallback(r.fallback)) {
    return { mode: "subscription", pairingId: r.pairingId, provider: r.provider, fallback: r.fallback };
  }
  if (
    r.mode === "local" &&
    isPairingId(r.pairingId) &&
    typeof r.modelRef === "string" &&
    LOCAL_MODEL_REF_RE.test(r.modelRef) &&
    isEngineFallback(r.fallback)
  ) {
    return { mode: "local", pairingId: r.pairingId, modelRef: r.modelRef, fallback: r.fallback };
  }
  if (r.mode === "api" && isApiEngineProvider(r.provider)) return { mode: "api", provider: r.provider };
  return null;
}

export function choiceFromSelection(selection: EngineSelection): AgentEngineChoice {
  if (selection.mode === "subscription") {
    return { kind: "cli", cli: selection.provider, pairingId: selection.pairingId, fallback: selection.fallback };
  }
  if (selection.mode === "local") {
    return { kind: "local", model: selection.modelRef, pairingId: selection.pairingId, fallback: selection.fallback };
  }
  return { kind: "api", provider: selection.provider };
}

export function selectionFromChoice(choice: AgentEngineChoice, apiProvider?: ApiEngineProvider): EngineSelection | null {
  if (choice.kind === "api") {
    const provider = choice.provider ?? apiProvider;
    return provider ? { mode: "api", provider } : null;
  }
  if (!choice.pairingId) return null;
  if (choice.kind === "cli") {
    return { mode: "subscription", pairingId: choice.pairingId, provider: choice.cli, fallback: choice.fallback ?? "none" };
  }
  if (!LOCAL_MODEL_REF_RE.test(choice.model)) return null;
  return { mode: "local", pairingId: choice.pairingId, modelRef: choice.model, fallback: choice.fallback ?? "none" };
}

/** A request body's choice, or null when it is not one. */
export function parseEngineChoice(raw: unknown): AgentEngineChoice | null {
  const selection = parseEngineSelection(raw);
  if (selection) return choiceFromSelection(selection);
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "api") return { kind: "api", ...(isApiEngineProvider(r.provider) ? { provider: r.provider } : {}) };
  if (r.kind === "cli" && isCliEngine(r.cli)) {
    const pairingId = isPairingId(r.pairingId) ? r.pairingId : undefined;
    const fallback = isEngineFallback(r.fallback) ? r.fallback : undefined;
    return { kind: "cli", cli: r.cli, ...(pairingId ? { pairingId } : {}), ...(fallback ? { fallback } : {}) };
  }
  if (r.kind === "local" && typeof r.model === "string" && isLocalModelName(r.model.trim())) {
    const pairingId = isPairingId(r.pairingId) ? r.pairingId : undefined;
    const fallback = isEngineFallback(r.fallback) ? r.fallback : undefined;
    return { kind: "local", model: r.model.trim(), ...(pairingId ? { pairingId } : {}), ...(fallback ? { fallback } : {}) };
  }
  return null;
}

/** Dual-read rollout adapter for already-open clients using the former
 * `{kind: ...}` payload. Legacy device choices remain unbound and are never
 * guessed; callers can return the explicit computer-upgrade repair. */
export function selectionFromRequest(
  raw: unknown,
  activeApiProvider?: ApiEngineProvider,
):
  | { selection: EngineSelection; legacy: boolean }
  | { selection: null; legacy: true; needsPairing: true }
  | null {
  const canonical = parseEngineSelection(raw);
  if (canonical) return { selection: canonical, legacy: false };
  const legacy = parseEngineChoice(raw);
  if (!legacy) return null;
  if (legacy.kind === "api") {
    const provider = legacy.provider ?? activeApiProvider;
    return provider ? { selection: { mode: "api", provider }, legacy: true } : null;
  }
  const selection = selectionFromChoice(legacy);
  return selection ? { selection, legacy: true } : { selection: null, legacy: true, needsPairing: true };
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
 * paired computer runs the harness on that app; a local selection runs the
 * selected local model on that same pairing; an AI account runs on the cloud
 * API. Device routes carry the complete immutable binding so browser state
 * cannot quietly swap the computer, runtime, or fallback policy.
 */
export type HarnessRoute =
  | {
      mode: "cli";
      runtime: CliEngine | null;
      pairingId: string;
      engineKind: "subscription" | "local";
      engineName: string;
      fallback: EngineFallback;
      note: null;
    }
  | {
      mode: "cloud_only";
      runtime: null;
      pairingId: null;
      engineKind: "api";
      engineName: ApiEngineProvider | null;
      fallback: "none";
      note: null;
    }
  | {
      mode: "unavailable";
      runtime: null;
      pairingId: null;
      engineKind: null;
      engineName: null;
      fallback: null;
      note: string;
    };

export function harnessRouteFor(choice: AgentEngineChoice): HarnessRoute {
  if (choice.kind !== "api" && !choice.pairingId) {
    return {
      mode: "unavailable",
      runtime: null,
      pairingId: null,
      engineKind: null,
      engineName: null,
      fallback: null,
      note: "Choose a computer in Settings > AI brain, test it, and save before starting coding work. Nothing was routed to another engine.",
    };
  }
  if (choice.kind === "cli") {
    return {
      mode: "cli",
      runtime: choice.cli,
      pairingId: choice.pairingId!,
      engineKind: "subscription",
      engineName: choice.cli,
      fallback: choice.fallback ?? "none",
      note: null,
    };
  }
  if (choice.kind === "local") {
    return {
      mode: "cli",
      runtime: null,
      pairingId: choice.pairingId!,
      engineKind: "local",
      engineName: choice.model,
      fallback: choice.fallback ?? "none",
      note: null,
    };
  }
  return {
    mode: "cloud_only",
    runtime: null,
    pairingId: null,
    engineKind: "api",
    engineName: choice.provider ?? null,
    fallback: "none",
    note: null,
  };
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

/** Visible prefix for any reply that spent workspace API credits in place of
 * the exact saved computer engine. This is reply content, not optional admin
 * metadata, so every recipient can see that fallback happened. */
export function workspaceApiFallbackReplyLabel(engineLine: string): string {
  return `Workspace API fallback - ${engineLine} could not answer. This reply uses workspace API credits; no other computer was used.\n\n`;
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
