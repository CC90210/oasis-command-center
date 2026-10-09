/**
 * Multi-provider chat client.
 *
 * Three providers, one streaming interface. Each adapter takes a normalized
 * request (messages, model, system, api_key) and yields token deltas as
 * { type: "delta", text } or { type: "done", input_tokens, output_tokens }.
 *
 * No SDK deps — straight fetch against each vendor's REST API. Keeps the
 * Vercel bundle small and avoids version drift.
 *
 * Provider 5xx / 429 errors auto-retry via fetchWithRetry (3 attempts,
 * 2s/4s/8s with jitter) so a single Anthropic/OpenRouter blip doesn't
 * kill the chat. Once we have an open stream we don't retry mid-stream.
 *
 * METERED (OASIS OS plan v2 §F2.6). Every request carries a ModelCallMeter
 * (lib/ai/usage.ts) built by the route from the session's tenant. streamChat
 * reserves the call against the tenant's monthly AI budget before it is sent
 * (a refusal is an error event whose message is the budget code) and writes
 * the call's ai_usage_events row from the provider's final usage report after,
 * whatever way the stream ends. The meter is a TYPE import here: this file is
 * imported by client components for PROVIDER_REGISTRY, so it must never pull
 * the server-only recorder into a browser bundle.
 */

import { fetchWithRetry } from "./retry";
import { asSSEArray, asSSERecord, parseSSE, safeText } from "./sse-parser";
import type { CallEnd, ModelCall, ModelCallMeter, ModelUsage } from "./ai/usage";
import { meterRefusalCode } from "./ai/usage-codes";
import { offeredModels, pickerLabel, resolveCall, type RegistryProvider } from "./ai/model-registry";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type Provider = "openrouter" | "anthropic" | "openai" | "google" | "ollama";

export type ChatRequest = {
  provider: Provider;
  model: string;
  apiKey: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Override base URL — required for `ollama` (where the operator's local
   *  endpoint isn't on the public internet) and useful for self-hosted
   *  OpenAI-compatible endpoints (LM Studio, vLLM, llama.cpp server). */
  baseUrl?: string;
  /**
   * The caller verified the person is the platform operator. Required for
   * provider `ollama`: its address comes from a saved row, so without this
   * streamChat refuses before calling it (lib/ai/workspace-account.ts).
   */
  allowLocalModel?: boolean;
  /** REQUIRED: meters this call for the tenant it serves (lib/ai/usage.ts modelCallMeter). */
  meter: ModelCallMeter;
};

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

/* ============================================================================
 * PROVIDER_REGISTRY — single source of truth for provider metadata.
 *
 * Replaces the duplicate PROVIDERS arrays that used to live independently in
 * components/landing/OnboardingFlow.tsx and components/settings/AgentConfigEditor.tsx.
 * Both surfaces now `import { PROVIDER_REGISTRY } from "@/lib/providers"` and
 * derive their pickers from this list. Add a provider once, both surfaces
 * pick it up.
 *
 * Per-surface presentation (taglines, badges) lives here too: separate fields
 * for each surface so the registry stays the canonical source even when the
 * wording differs slightly. The MODEL lists of the four hosted providers are
 * not typed here: they are lib/ai/model-registry.ts's offered models (the
 * provider's default first), so a picker can never offer a model that registry
 * knows is gone. The local-model list stays here: those are tags on the
 * operator's own machine, which no provider retires.
 * ============================================================================ */

/** A hosted provider's picker list: the registry's offered models, default first. */
function registryModels(provider: RegistryProvider): Array<{ id: string; label: string }> {
  return offeredModels(provider).map((m) => ({ id: m.id, label: pickerLabel(m) }));
}
export type ProviderRegistryEntry = {
  value: Provider;
  /** Short label used in pickers (Onboarding's tile, AgentConfigEditor's <select>). */
  label: string;
  /** One-line summary for Onboarding (under the tile). */
  tagline: string;
  /** Longer prose for AgentConfigEditor (under the dropdown). */
  hint: string;
  /** Sign-up + API key URLs (sourced from PROVIDER_LINKS). */
  signup: string;
  apiKey: string;
  /** Optional doc URL — surfaced in the AgentConfigEditor "Get API key" button. */
  docs?: string;
  /** Picker models, with optional pretty labels for OnboardingFlow. */
  models: Array<{ id: string; label: string }>;
  /** Onboarding placeholder for the API-key input. */
  placeholder: string;
  /** Star tile in Onboarding ("★ recommended"). */
  badge?: string;
  /** True for OpenRouter — surfaces the "recommended" flag in AgentConfigEditor. */
  recommended?: boolean;
};

export const PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
  {
    value: "openrouter",
    label: "OpenRouter",
    tagline: "One key, every model — recommended",
    hint: "One key, every model. Easiest path — pay-as-you-go, no per-provider setup.",
    signup: "https://openrouter.ai/sign-up",
    apiKey: "https://openrouter.ai/keys",
    docs: "https://openrouter.ai/docs/quick-start",
    models: registryModels("openrouter"),
    placeholder: "sk-or-v1-...",
    badge: "★ recommended",
    recommended: true,
  },
  {
    value: "anthropic",
    label: "Anthropic Direct",
    tagline: "Claude only — best if you already have an Anthropic account",
    hint: "Direct to Claude. Best for Anthropic-only deployments.",
    signup: "https://console.anthropic.com/signup",
    apiKey: "https://console.anthropic.com/settings/keys",
    docs: "https://docs.anthropic.com/en/api/getting-started",
    models: registryModels("anthropic"),
    placeholder: "sk-ant-...",
  },
  {
    value: "openai",
    label: "OpenAI Direct",
    // GPT-5.3 Codex is deprecated (shutdown 2027-04-01) and no longer offered,
    // and GPT-6 is not offered yet (lib/ai/model-registry.ts), so neither is promised.
    tagline: "GPT-5.x models, pay-as-you-go via OpenAI",
    hint: "Direct to OpenAI. GPT-6 is not offered here yet: its tool calls need OpenAI's newer API.",
    signup: "https://platform.openai.com/signup",
    apiKey: "https://platform.openai.com/api-keys",
    docs: "https://platform.openai.com/docs/quickstart",
    models: registryModels("openai"),
    placeholder: "sk-proj-...",
  },
  {
    value: "google",
    label: "Google Gemini",
    tagline: "Paid tier only. The free AI Studio tier may train on your data.",
    hint: "Direct to Gemini via AI Studio. Paid tier only: the free AI Studio tier may train on your data, so it is not for a workspace's clients.",
    signup: "https://aistudio.google.com/",
    apiKey: "https://aistudio.google.com/apikey",
    docs: "https://ai.google.dev/gemini-api/docs",
    models: registryModels("google"),
    placeholder: "AIza...",
  },
  {
    value: "ollama",
    label: "Local model (Ollama / LM Studio)",
    tagline:
      "Zero per-call cost · full data residency · pair with the local bridge for best results",
    hint:
      "Runs on your machine. Paste your local endpoint URL in the key field (http://localhost:11434/v1 for Ollama, :1234/v1 for LM Studio). Pair with the local bridge for best results.",
    // No "signup" — the operator runs Ollama on their own machine.
    // The signup link points to the install docs as a stand-in.
    signup: "https://ollama.com/download",
    apiKey: "https://ollama.com/library",
    docs: "https://github.com/ollama/ollama/blob/main/docs/api.md",
    models: [
      { id: "llama3.3:70b", label: "Llama 3.3 70B (best — needs 48GB+ GPU)" },
      { id: "llama3.3", label: "Llama 3.3 (default tag)" },
      { id: "qwen2.5:72b", label: "Qwen 2.5 72B (strong reasoning)" },
      { id: "qwen2.5-coder:32b", label: "Qwen 2.5 Coder 32B (code-focused)" },
      { id: "mistral", label: "Mistral 7B (light, fast)" },
      { id: "deepseek-r1:70b", label: "DeepSeek R1 70B (reasoning model)" },
    ],
    placeholder: "http://localhost:11434/v1  (or LM Studio: http://localhost:1234/v1)",
  },
];

/* ============================================================================
 * Derived exports — keep the legacy lookup-shapes alive for callers that
 * already import them. Each is a Map-flavored projection of PROVIDER_REGISTRY,
 * computed once at module load. Adding a new provider to the registry above
 * automatically extends all three.
 * ============================================================================ */

/** Provider → list of model IDs (used by /api/agent-config validation). */
export const PROVIDER_MODELS: Record<Provider, string[]> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.value, p.models.map((m) => m.id)])
) as Record<Provider, string[]>;

/** Provider → human-readable label (used in chat header copy). */
export const PROVIDER_LABEL: Record<Provider, string> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.value, p.label])
) as Record<Provider, string>;

/** Provider → signup + API key + docs URLs. */
export const PROVIDER_LINKS: Record<Provider, { signup: string; apiKey: string; docs?: string }> =
  Object.fromEntries(
    PROVIDER_REGISTRY.map((p) => [
      p.value,
      { signup: p.signup, apiKey: p.apiKey, docs: p.docs },
    ])
  ) as Record<Provider, { signup: string; apiKey: string; docs?: string }>;

/** Lookup helper — `getProvider("anthropic")` returns the registry entry. */
export function getProvider(value: Provider): ProviderRegistryEntry | null {
  return PROVIDER_REGISTRY.find((p) => p.value === value) || null;
}

/**
 * Given a model id (e.g. `"claude-opus-4-7"`, `"anthropic/claude-sonnet-4.6"`),
 * return the first provider that lists it. Used by the `/model` slash command
 * so the operator can type a model id without re-stating the provider.
 *
 * Returns null when no provider claims the model.
 */
export function providerForModel(modelId: string): Provider | null {
  const id = modelId.trim();
  if (!id) return null;
  for (const p of PROVIDER_REGISTRY) {
    if (p.models.some((m) => m.id === id)) return p.value;
  }
  return null;
}

/**
 * Canonical provider → integration-registry service-slug map. Lives here
 * (in client-safe pure-data territory) so both server code (queries.ts's
 * aiServicesWithKey) and client surfaces (ProviderAccountsCard) can
 * import it without pulling server-only deps into the client bundle.
 *
 * Previously this lived in queries.ts; that broke the production build
 * the moment the client-side ProviderAccountsCard tried to import it —
 * queries.ts transitively imports next/headers via supabase-server.ts,
 * which Next 15 (App Router) refuses to bundle into a client component.
 * The fix is keeping the data here, where it semantically belongs.
 */
export const PROVIDER_TO_SERVICE: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai_codex",
  google: "google_ai",
  openrouter: "openrouter",
};

/* ============================================================================
 * Public entry point — async generator that yields StreamEvents.
 * ============================================================================ */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  // A local model server is called only for the verified operator: its address
  // came from a saved row, and a row saved for anyone else must not make this
  // server call it. Every caller resolves that verdict; a caller that does not
  // pass it gets no request (Codex review, PR #535).
  if (req.provider === "ollama" && req.allowLocalModel !== true) {
    yield { type: "error", message: "local_model_not_allowed" };
    return;
  }
  // Ollama / LM Studio run locally without auth — empty key is fine.
  // Every other provider needs a key.
  if (!req.apiKey && req.provider !== "ollama") {
    yield { type: "error", message: "missing_api_key" };
    return;
  }
  if (!req.messages.length) {
    yield { type: "error", message: "empty_messages" };
    return;
  }
  // A saved model the registry knows is gone (retired, served only to past
  // users, or past its end date) is sent as its replacement on the SAME
  // provider, with the same key, and the call's ai_usage_events row records
  // why (fallback_reason). Anything else is sent exactly as asked.
  const picked = resolveCall(req.provider, req.model, req.meter);
  if (picked.swap) req = { ...req, model: picked.model, meter: picked.meter };
  switch (req.provider) {
    case "openrouter":
      yield* streamOpenRouter(req);
      return;
    case "anthropic":
      yield* streamAnthropic(req);
      return;
    case "openai":
      yield* streamOpenAI(req);
      return;
    case "google":
      yield* streamGoogle(req);
      return;
    case "ollama":
      yield* streamOllama(req);
      return;
    default:
      yield { type: "error", message: `unknown_provider:${req.provider}` };
  }
}

/* ============================================================================
 * The metered request, shared by every adapter.
 *
 * Each adapter says WHAT to send and HOW to read its stream; this owns the
 * order that makes the ledger exact: reserve (meter.begin) → send → read →
 * `done` → one ai_usage_events row. The row is written in `finally`, so a
 * request that is refused (non-2xx: nothing billed), breaks off (usage
 * unknown), or is abandoned by its consumer (cancelled) still gets exactly one.
 * ============================================================================ */

/** What a stream reader fills in as the provider reports it. */
type UsageAcc = {
  /** The `done` event's numbers, as each adapter has always reported them. */
  doneIn: number;
  doneOut: number;
  /** For the ledger. null until the provider reports it. */
  ledger: ModelUsage;
  /** The provider's final usage report arrived (the message completed). */
  complete: boolean;
  /**
   * Why the provider says it stopped, normalised (finishKind): "length" (the
   * output budget ran out), "blocked" (a safety or content filter), "stop" (a
   * natural end) or "other". null until the provider says.
   */
  finish: FinishKind | null;
};

/**
 * Why a reply stopped, in one word per meaning, whatever the provider calls it:
 *   Google    candidate.finishReason MAX_TOKENS / SAFETY, RECITATION, ... / STOP,
 *             or promptFeedback.blockReason (the prompt itself was blocked);
 *   Anthropic message_delta stop_reason max_tokens / refusal / end_turn;
 *   OpenAI-compatible choice.finish_reason length / content_filter / stop.
 */
export type FinishKind = "length" | "blocked" | "stop" | "other";

const GOOGLE_BLOCKED = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

/** A provider's own stop word, as a FinishKind. */
export function finishKind(provider: Provider, raw: unknown): FinishKind | null {
  if (typeof raw !== "string" || !raw) return null;
  if (provider === "google") {
    if (raw === "MAX_TOKENS") return "length";
    if (raw === "STOP") return "stop";
    if (GOOGLE_BLOCKED.has(raw)) return "blocked";
    return raw === "FINISH_REASON_UNSPECIFIED" ? null : "other";
  }
  if (provider === "anthropic") {
    if (raw === "max_tokens") return "length";
    if (raw === "refusal") return "blocked";
    if (raw === "end_turn" || raw === "stop_sequence") return "stop";
    return "other";
  }
  if (raw === "length") return "length";
  if (raw === "content_filter") return "blocked";
  if (raw === "stop") return "stop";
  return "other";
}

/**
 * The error message of a reply that finished with NO answer text, by why
 * (lib/os/channel/outcome.ts classifyStreamError turns it into a failure code):
 *   empty_reply:thinking  the output budget ran out before any answer text: on a
 *                         thinking model the budget went to its thinking
 *                         (thinking tokens count against the output cap, Gemini
 *                         docs "Thinking", and OpenAI's reasoning tokens alike);
 *   empty_reply:blocked   a safety or content filter stopped it;
 *   empty_reply:empty     the provider ended normally with nothing to say.
 * Never a success: an empty answer is a failed turn, in the channel and in the
 * usage ledger (CC, 2026-10-09: Chief of Staff showed "The reply came back
 * empty" while its ai_usage_events row said "ok").
 */
export type EmptyReplyKind = "thinking" | "blocked" | "empty";

export function emptyReplyKind(finish: FinishKind | null): EmptyReplyKind {
  if (finish === "length") return "thinking";
  if (finish === "blocked") return "blocked";
  return "empty";
}

/**
 * Thinking models spend part of the output cap on thinking before they write
 * a word (Gemini 3.x and OpenAI's reasoning models both count those tokens
 * against it). The caller's maxTokens is the ANSWER's budget; this much more is
 * sent as the cap on those models so the answer still has its room.
 */
export const THINKING_HEADROOM_TOKENS = 4096;

/**
 * GPT-5-family models the registry knows that do not reason by default:
 * gpt-5.1 defaults to reasoning effort "none" (OpenAI's model page;
 * CodeRabbit, #561).
 */
const OPENAI_NON_REASONING_MODELS: ReadonlySet<string> = new Set(["gpt-5.1"]);

/** OpenAI's reasoning models (GPT-5.x, GPT-6, the o-series): their reasoning counts against the output cap. */
export function openaiReasons(model: string): boolean {
  if (OPENAI_NON_REASONING_MODELS.has(model)) return false;
  return /^(?:gpt-[5-9](?:[.-]|$)|o\d(?:-|$))/.test(model);
}

/** Gemini 3.x takes thinkingConfig.thinkingLevel; 2.5 and older do not (a 400). */
export function geminiTakesThinkingLevel(model: string): boolean {
  return /^gemini-3(?:[.-]|$)/.test(model);
}

type MeteredSpec = {
  provider: Provider;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  maxOutputTokens: number;
  /** The error message for a non-2xx answer (each adapter's historical shape). */
  refusal: (status: number, detail: string) => string;
  read: (body: ReadableStream<Uint8Array>, acc: UsageAcc) => AsyncGenerator<StreamEvent>;
};

const utf8 = new TextEncoder();

async function* metered(meter: ModelCallMeter, spec: MeteredSpec): AsyncGenerator<StreamEvent> {
  const json = JSON.stringify(spec.body);
  let call: ModelCall;
  try {
    call = await meter.begin({
      provider: spec.provider,
      model: spec.model,
      maxOutputTokens: spec.maxOutputTokens,
      promptBytes: utf8.encode(json).length,
    });
  } catch (err) {
    // A budget refusal (or a budget that could not be read): nothing was sent.
    yield { type: "error", message: meterRefusalCode(err) };
    return;
  }
  const acc: UsageAcc = {
    doneIn: 0,
    doneOut: 0,
    ledger: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
    complete: false,
    finish: null,
  };
  let end: CallEnd | null = null;
  try {
    const res = await fetchWithRetry(spec.url, { method: "POST", headers: spec.headers, body: json });
    if (!res.ok || !res.body) {
      const detail = await safeText(res);
      // A provider that refused the request generated nothing, so billed nothing.
      end = res.ok
        ? { outcome: "error", errorCode: "empty_body" }
        : { outcome: "error", errorCode: `http_${res.status}`, notBilled: true };
      yield { type: "error", message: spec.refusal(res.status, detail) };
      return;
    }
    // An answer is text someone can read: a stream that ends without any is a
    // FAILED turn with its reason, in the ledger and to the caller, never an
    // "ok" with nothing in it (see EmptyReplyKind). Whatever the provider
    // billed for it (a budget spent thinking) is still recorded.
    let answered = false;
    for await (const ev of spec.read(res.body, acc)) {
      if (ev.type === "delta" && ev.text.trim()) answered = true;
      yield ev;
    }
    if (!answered) {
      const kind = emptyReplyKind(acc.finish);
      end = { outcome: "error", errorCode: `empty_reply_${kind}`, usage: acc.complete ? acc.ledger : null };
      yield { type: "error", message: `empty_reply:${kind}` };
      return;
    }
    end = { outcome: "ok", usage: acc.complete ? acc.ledger : null };
    yield { type: "done", inputTokens: acc.doneIn, outputTokens: acc.doneOut };
  } catch (err) {
    end = { outcome: "error", errorCode: "stream_failed", usage: null };
    throw err;
  } finally {
    await call.finish(end ?? { outcome: "cancelled", usage: null });
  }
}

/** The historical error shapes, which lib/os/channel/outcome.ts classifies. */
function hostedRefusal(tag: string) {
  return (status: number, detail: string) =>
    status >= 500 || status === 429 ? `provider_temporarily_unavailable:${tag}_${status}` : `${tag}_${status}:${detail}`;
}

/**
 * OpenAI-compatible usage (OpenAI, OpenRouter, Ollama / LM Studio). prompt_tokens
 * includes the cached prefix; the ledger's input is the uncached part.
 * OpenRouter adds usage.cost (USD, what it charged) and cache_write_tokens.
 */
function readOpenAIUsage(usage: Record<string, unknown>, acc: UsageAcc): void {
  acc.doneIn = numberOr(usage.prompt_tokens, acc.doneIn);
  acc.doneOut = numberOr(usage.completion_tokens, acc.doneOut);
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  const details = asSSERecord(usage.prompt_tokens_details);
  const cached = numberOr(details?.cached_tokens, 0);
  const written = numberOr(details?.cache_write_tokens, 0);
  acc.ledger = {
    inputTokens: prompt === null ? null : Math.max(prompt - cached - written, 0),
    outputTokens: completion,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    providerCostUsd: typeof usage.cost === "number" ? usage.cost : null,
  };
  acc.complete = prompt !== null && completion !== null;
}

async function* readOpenAICompatible(body: ReadableStream<Uint8Array>, acc: UsageAcc): AsyncGenerator<StreamEvent> {
  for await (const event of parseSSE(body)) {
    const data = asSSERecord(event.data);
    if (!data) continue;
    const choice = firstSSERecord(data.choices);
    const delta = asSSERecord(choice?.delta)?.content;
    if (typeof delta === "string" && delta.length) yield { type: "delta", text: delta };
    acc.finish = finishKind("openai", choice?.finish_reason) ?? acc.finish;
    const usage = asSSERecord(data.usage);
    if (usage) readOpenAIUsage(usage, acc);
  }
}

/* ============================================================================
 * Ollama / LM Studio / any OpenAI-compatible local endpoint.
 *
 * baseUrl points at the operator's local model server. Defaults to the
 * standard Ollama address (http://localhost:11434/v1). LM Studio's default
 * (http://localhost:1234/v1) and any other OpenAI-compatible local server
 * works by passing `baseUrl` in the agent_model_config row.
 *
 * This path runs in the dashboard server. For client-installed local
 * models, the dashboard cannot reach the operator's machine directly —
 * the bridge proxies the call (or, for cloud-only clients, this provider
 * isn't usable). Documented in the playbook + onboarding.
 *
 * Wire format is OpenAI-compatible (Ollama and LM Studio both expose
 * /v1/chat/completions). Same code path as streamOpenAI minus the bearer
 * auth (Ollama doesn't require one for local installs).
 * ============================================================================ */
function streamOllama(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const base = (req.baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  const messages: Array<{ role: ChatRole; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push(...req.messages);

  const maxTokens = req.maxTokens ?? 4096;
  const headers: Record<string, string> = { "content-type": "application/json" };
  // LM Studio honors a Bearer key when configured; Ollama ignores it.
  // Pass through whatever the operator stored (often "ollama" or
  // a user-set token) for compatibility.
  if (req.apiKey && req.apiKey !== "ollama") {
    headers.authorization = `Bearer ${req.apiKey}`;
  }
  return metered(req.meter, {
    provider: "ollama",
    model: req.model,
    url: `${base}/chat/completions`,
    headers,
    body: {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    },
    maxOutputTokens: maxTokens,
    refusal: (status, detail) =>
      status >= 500 || status === 429 ? `local_model_temporarily_unavailable:${status}` : `ollama_${status}:${detail}`,
    read: readOpenAICompatible,
  });
}

/* ============================================================================
 * OpenRouter — OpenAI-compatible /api/v1/chat/completions
 * One key, hundreds of models. Recommended onboarding path.
 * ============================================================================ */
function streamOpenRouter(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const messages: Array<{ role: ChatRole; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push(...req.messages);

  const maxTokens = req.maxTokens ?? 4096;
  return metered(req.meter, {
    provider: "openrouter",
    model: req.model,
    url: "https://openrouter.ai/api/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
      "HTTP-Referer": "https://oasisai.work",
      "X-Title": "OASIS Agent Command Center",
    },
    body: {
      model: req.model,
      messages,
      stream: true,
      max_tokens: maxTokens,
    },
    maxOutputTokens: maxTokens,
    refusal: hostedRefusal("openrouter"),
    read: readOpenAICompatible,
  });
}

/* ============================================================================
 * Anthropic — /v1/messages with stream:true SSE
 * ============================================================================ */
function streamAnthropic(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const maxTokens = req.maxTokens ?? 4096;
  return metered(req.meter, {
    provider: "anthropic",
    model: req.model,
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: req.model,
      max_tokens: maxTokens,
      stream: true,
      system: req.system,
      messages: req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    },
    maxOutputTokens: maxTokens,
    refusal: hostedRefusal("anthropic"),
    read: readAnthropic,
  });
}

/**
 * message_start carries the prompt side (input_tokens is uncached; cache reads
 * and writes are their own counts); message_delta carries the CUMULATIVE
 * output count, so the last one is the total. The message is complete, for the
 * ledger, once a message_delta reported its output.
 */
async function* readAnthropic(body: ReadableStream<Uint8Array>, acc: UsageAcc): AsyncGenerator<StreamEvent> {
  for await (const event of parseSSE(body)) {
    const data = asSSERecord(event.data);
    if (!data) continue;
    if (event.event === "message_start") {
      const usage = asSSERecord(asSSERecord(data.message)?.usage);
      if (usage) {
        acc.doneIn = numberOr(usage.input_tokens, 0);
        acc.ledger.inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
        acc.ledger.cacheReadTokens = numberOr(usage.cache_read_input_tokens, 0);
        acc.ledger.cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, 0);
      }
    } else if (event.event === "content_block_delta") {
      const text = asSSERecord(data.delta)?.text;
      if (typeof text === "string") yield { type: "delta", text };
    } else if (event.event === "message_delta") {
      acc.finish = finishKind("anthropic", asSSERecord(data.delta)?.stop_reason) ?? acc.finish;
      const usage = asSSERecord(data.usage);
      if (typeof usage?.output_tokens === "number") {
        acc.doneOut = usage.output_tokens;
        acc.ledger.outputTokens = usage.output_tokens;
        acc.complete = acc.ledger.inputTokens !== null;
      }
    } else if (event.event === "message_stop") {
      break;
    }
  }
}

/* ============================================================================
 * OpenAI — /v1/chat/completions stream:true (works for gpt-5.x)
 * ============================================================================ */
function streamOpenAI(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const messages: Array<{ role: ChatRole; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push(...req.messages);

  // GPT-5.x and later (and the o-series) reason before they answer, and those
  // reasoning tokens count against max_completion_tokens: the answer's budget
  // plus the headroom, on those models only (a non-reasoning model would only
  // reserve budget it never uses; CodeRabbit, #561).
  const maxTokens = (req.maxTokens ?? 4096) + (openaiReasons(req.model) ? THINKING_HEADROOM_TOKENS : 0);
  return metered(req.meter, {
    provider: "openai",
    model: req.model,
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxTokens,
    },
    maxOutputTokens: maxTokens,
    refusal: hostedRefusal("openai"),
    read: readOpenAICompatible,
  });
}

/* ============================================================================
 * Google Gemini — :streamGenerateContent SSE
 * ============================================================================ */
function streamGoogle(req: ChatRequest): AsyncGenerator<StreamEvent> {
  // Pass the API key in the `x-goog-api-key` header instead of the URL
  // query string. Google supports both, but URL params can leak via
  // server logs, error response bodies that echo the request URL, and
  // any error stack trace that quotes the URL. Header-based auth keeps
  // the credential out of those surfaces.
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      req.model
    )}:streamGenerateContent?alt=sse`;

  // Gemini 3.x thinks before it answers, by default at a "medium" level, and
  // its thinking tokens count against maxOutputTokens (Gemini docs "Thinking":
  // the cap is "the maximum number of tokens a response can generate,
  // including thought tokens"; a cap reached while thinking ends MAX_TOKENS
  // with the answer empty, thinking still billed). A chat reply asks for the
  // LOW level, which every Gemini 3.x model takes (3.8 Flash does not take
  // "minimal"), and the cap is the answer's budget plus thinking headroom.
  const thinks = geminiTakesThinkingLevel(req.model);
  const maxTokens = (req.maxTokens ?? 4096) + (thinks ? THINKING_HEADROOM_TOKENS : 0);
  const contents = req.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: thinks
      ? { maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: "low" } }
      : { maxOutputTokens: maxTokens },
  };
  if (req.system) {
    body.systemInstruction = { role: "user", parts: [{ text: req.system }] };
  }
  return metered(req.meter, {
    provider: "google",
    model: req.model,
    url,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": req.apiKey,
    },
    body,
    maxOutputTokens: maxTokens,
    refusal: hostedRefusal("google"),
    read: readGoogle,
  });
}

/**
 * usageMetadata repeats, cumulative, on every chunk: the last one is the total.
 * promptTokenCount includes the cached prefix (cachedContentTokenCount), and
 * thinking tokens (thoughtsTokenCount) are billed as output but are not in
 * candidatesTokenCount, so the ledger adds them. A reply that spent its whole
 * cap thinking has NO candidatesTokenCount at all, only thoughtsTokenCount:
 * that is zero answer tokens, not an unknown count, so the ledger still
 * records the thinking it billed.
 *
 * A part marked `thought: true` is the model's thinking (a summary, sent only
 * when asked for), never answer text. finishReason says why it stopped, and a
 * promptFeedback.blockReason says the prompt itself was blocked (no candidate
 * at all): both are kept for the empty-reply verdict in metered().
 */
async function* readGoogle(body: ReadableStream<Uint8Array>, acc: UsageAcc): AsyncGenerator<StreamEvent> {
  for await (const event of parseSSE(body)) {
    const data = asSSERecord(event.data);
    if (!data) continue;
    const candidate = firstSSERecord(data.candidates);
    const parts = asSSEArray(asSSERecord(candidate?.content)?.parts);
    if (Array.isArray(parts)) {
      for (const p of parts) {
        const part = asSSERecord(p);
        if (part?.thought === true) continue;
        if (typeof part?.text === "string" && part.text.length) {
          yield { type: "delta", text: part.text };
        }
      }
    }
    acc.finish = finishKind("google", candidate?.finishReason) ?? acc.finish;
    if (typeof asSSERecord(data.promptFeedback)?.blockReason === "string") acc.finish = "blocked";
    const usageMetadata = asSSERecord(data.usageMetadata);
    if (usageMetadata) {
      acc.doneIn = numberOr(usageMetadata.promptTokenCount, acc.doneIn);
      acc.doneOut = numberOr(usageMetadata.candidatesTokenCount, acc.doneOut);
      const prompt = typeof usageMetadata.promptTokenCount === "number" ? usageMetadata.promptTokenCount : null;
      const thoughts = typeof usageMetadata.thoughtsTokenCount === "number" ? usageMetadata.thoughtsTokenCount : null;
      const candidates =
        typeof usageMetadata.candidatesTokenCount === "number" ? usageMetadata.candidatesTokenCount : thoughts !== null ? 0 : null;
      const cached = numberOr(usageMetadata.cachedContentTokenCount, 0);
      acc.ledger = {
        inputTokens: prompt === null ? null : Math.max(prompt - cached, 0),
        outputTokens: candidates === null ? null : candidates + (thoughts ?? 0),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
      acc.complete = prompt !== null && candidates !== null;
    }
  }
}

function firstSSERecord(value: unknown): Record<string, unknown> | null {
  return asSSERecord(asSSEArray(value)[0]);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

// SSE parser + safeText now live in lib/sse-parser.ts (shared with
// lib/cloud-tool-runner.ts). Imported above.
