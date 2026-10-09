/**
 * lib/agents/provider-probe.ts — "does this key actually answer?", asked the
 * only way that proves it: a real one-token completion.
 *
 * WHY NOT LIST MODELS. The test-connection route used to GET each provider's
 * model list. That call does not spend, so it does not prove the account can
 * spend: OpenRouter answers GET /models with 200 for no key or a bad key, and a
 * zero-balance Anthropic key lists models fine and then refuses every message
 * with 400 "credit balance is too low". The owner saw a green check over a key
 * every department channel was failing on.
 *
 * So each probe sends one short user message with an output cap of ONE token.
 * It costs a fraction of a cent. The failure is reduced to the same code a chat
 * turn records (lib/os/channel/outcome.ts).
 *
 * WHICH MODEL. A saved key is tested on the model saved WITH it (the caller
 * passes `model`), which is the model the channel sends it, so "Test" and the
 * channel ask the provider the same question. A key with no model yet (one
 * pasted before saving) is tested on the provider's cheapest listed model
 * (PROBE_MODEL). Some refusals are about the model, not the key: a project key
 * without access to it (403), or a model the account cannot see (404). Those
 * name the model they were about, so a red "Test" is never read as a verdict on
 * a key the channel's own model would accept.
 *
 * A local server (Ollama, LM Studio) has no account to bill: the probe asks it
 * for its model list and then runs the one-token completion on the saved model,
 * or on the first model it has.
 *
 * `fetchImpl` is injectable so tests assert the exact request each provider
 * gets without a network.
 *
 * METERED. A probe spends, so it is a model call like any other: `meter`
 * (lib/ai/usage.ts, surface "probe") reserves it against the workspace's
 * monthly AI budget and records its ai_usage_events row from the usage the
 * provider reports. A workspace at its cap is told so instead of being tested.
 * Ollama's model LIST is not a model call and is not metered; its one-token
 * completion is.
 */
import "server-only";
import { classifyProviderStatus, classifyStreamError, failureCopy, type TurnFailureCode } from "@/lib/os/channel/outcome";
import { streamChat, type Provider } from "@/lib/providers";
import type { CallEnd, ModelCall, ModelCallMeter, ModelUsage } from "@/lib/ai/usage";
import { AI_USAGE_UNAVAILABLE, isAiBudgetCode, meterRefusalCode } from "@/lib/ai/usage-codes";
import { MODEL_REGISTRY, modelFactsForCopy, resolveCall, resolveModelForCall } from "@/lib/ai/model-registry";
import { DEPARTMENT_REPLY_MAX_TOKENS, DEPARTMENT_TEST_ASK, DEPARTMENT_TEST_SYSTEM } from "@/lib/os/channel/reply-budget";

export const PROBE_TIMEOUT_MS = 15_000;

/**
 * The model each provider's key is tested on when no model is named: the
 * registry's probe pick (lib/ai/model-registry.ts probeModel), a cheap model
 * every account can call that answers a one-token test without a reasoning
 * step (a one-token cap on a model that must think first can come back empty
 * or refused for a reason that says nothing about the key). It was
 * gemini-2.5-flash, which Google serves only to projects that used it before,
 * so a good key from a new Google project failed its own test.
 */
export const PROBE_MODEL: Record<Exclude<Provider, "ollama">, string> = {
  openrouter: MODEL_REGISTRY.openrouter.probeModel,
  anthropic: MODEL_REGISTRY.anthropic.probeModel,
  openai: MODEL_REGISTRY.openai.probeModel,
  google: MODEL_REGISTRY.google.probeModel,
};

const PROBE_TEXT = "Reply with one word: ok";
/** OpenRouter's floor: "some providers enforce a minimum max_tokens of 16" (its chat-completions docs). */
export const OPENROUTER_MIN_MAX_TOKENS = 16;

export type ProbeRequest = { url: string; init: RequestInit };

export type ProbeResult =
  | { ok: true; latency_ms: number; model: string }
  | {
      ok: false;
      code: TurnFailureCode | "timeout" | "network" | "no_local_model" | typeof AI_USAGE_UNAVAILABLE;
      message: string;
    };

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

type ProbeOptions = {
  /** The model saved with the key; PROBE_MODEL (or Ollama's first) when absent. */
  model?: string | null;
  fetchImpl?: FetchImpl;
  /** REQUIRED: meters the one-token completion (lib/ai/usage.ts, surface "probe"). */
  meter: ModelCallMeter;
};

/** The exact one-token completion each hosted provider receives. */
export function buildProbeRequest(
  provider: Exclude<Provider, "ollama">,
  key: string,
  model: string = PROBE_MODEL[provider],
): ProbeRequest {
  const json = { "content-type": "application/json" };
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: { ...json, "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: PROBE_TEXT }] }),
      },
    };
  }
  if (provider === "google") {
    // Key in the header, never the URL: a URL leaks through logs and echoed errors.
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: "POST",
        headers: { ...json, "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROBE_TEXT }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
    };
  }
  if (provider === "openai") {
    // gpt-5.x takes max_completion_tokens; max_tokens is refused on it.
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: { ...json, authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_completion_tokens: 1, messages: [{ role: "user", content: PROBE_TEXT }] }),
      },
    };
  }
  // Some OpenRouter providers refuse max_tokens below 16 ("below minimum value"),
  // which would read a good key as broken. 16 tokens still cost next to nothing.
  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    init: {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: OPENROUTER_MIN_MAX_TOKENS, messages: [{ role: "user", content: PROBE_TEXT }] }),
    },
  };
}

async function timed(fetchImpl: FetchImpl, req: ProbeRequest): Promise<{ res: Response; ms: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetchImpl(req.url, { ...req.init, signal: ctl.signal });
    return { res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A refusal, in the owner-facing words a channel would use for it, except the
 * two that are about the MODEL tested: those name it (see WHICH MODEL above).
 * A model the provider says was not found is named the way a channel names it
 * (lib/os/channel/outcome.ts): retired, or not available to this AI account,
 * and what to pick instead.
 */
async function refusal(res: Response, model: string | null, provider: Provider): Promise<ProbeResult> {
  const body = await res.text().catch(() => "");
  const code = classifyProviderStatus(res.status, body);
  if (model && code === "provider_403") {
    return {
      ok: false,
      code,
      message: `This key is not allowed to use ${model}. Check the key's access, or pick another model in AI settings.`,
    };
  }
  if (model && code === "provider_404") {
    return { ok: false, code, message: failureCopy(code, { canManageAi: true, model: modelFactsForCopy(provider, model) }).sentence };
  }
  return { ok: false, code, message: failureCopy(code, { canManageAi: true }).sentence };
}

function thrown(err: unknown, provider: Provider): ProbeResult {
  if ((err as Error)?.name === "AbortError") {
    return {
      ok: false,
      code: "timeout",
      message: `The AI provider did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.${
        provider === "ollama" ? " Is the local model server running and reachable?" : " Try again in a minute."
      }`,
    };
  }
  return {
    ok: false,
    code: "network",
    message:
      provider === "ollama"
        ? "Could not reach the local model server at that address."
        : "Could not reach the AI provider. Try again in a minute.",
  };
}

/**
 * The usage in a probe's (non-streamed) response, for the ledger. Each
 * provider's own shape; input is UNCACHED input. null when it reported none.
 */
function probeUsage(provider: Provider, body: unknown): ModelUsage | null {
  const r = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (provider === "anthropic") {
    const u = obj(r?.usage);
    const input = num(u?.input_tokens);
    const output = num(u?.output_tokens);
    if (input === null || output === null) return null;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: num(u?.cache_read_input_tokens) ?? 0,
      cacheWriteTokens: num(u?.cache_creation_input_tokens) ?? 0,
    };
  }
  if (provider === "google") {
    const u = obj(r?.usageMetadata);
    const prompt = num(u?.promptTokenCount);
    const candidates = num(u?.candidatesTokenCount);
    if (prompt === null) return null;
    const cached = num(u?.cachedContentTokenCount) ?? 0;
    // A one-token cap can end with no candidate tokens at all (candidatesTokenCount absent).
    return {
      inputTokens: Math.max(prompt - cached, 0),
      outputTokens: (candidates ?? 0) + (num(u?.thoughtsTokenCount) ?? 0),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }
  // OpenAI-compatible: openai, openrouter, ollama.
  const u = obj(r?.usage);
  const prompt = num(u?.prompt_tokens);
  const completion = num(u?.completion_tokens);
  if (prompt === null || completion === null) return null;
  const details = obj(u?.prompt_tokens_details);
  const cached = num(details?.cached_tokens) ?? 0;
  const written = num(details?.cache_write_tokens) ?? 0;
  return {
    inputTokens: Math.max(prompt - cached - written, 0),
    outputTokens: completion,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    providerCostUsd: num(u?.cost),
  };
}

/**
 * Send one probe completion through the meter: reserve, send, then record
 * exactly one row however it ends. A budget refusal comes back as the result.
 */
async function meteredProbe(
  provider: Provider,
  meter: ModelCallMeter,
  fetchImpl: FetchImpl,
  req: ProbeRequest,
  model: string,
  maxOutputTokens: number,
): Promise<ProbeResult> {
  let call: ModelCall;
  try {
    call = await meter.begin({
      provider,
      model,
      maxOutputTokens,
      promptBytes: new TextEncoder().encode(String(req.init.body ?? "")).length,
    });
  } catch (err) {
    const code = meterRefusalCode(err);
    return {
      ok: false,
      code: isAiBudgetCode(code) ? code : AI_USAGE_UNAVAILABLE,
      message: isAiBudgetCode(code)
        ? failureCopy(code, { canManageAi: true }).sentence
        : "The AI budget could not be checked just now, so the key was not tested. Try again in a moment.",
    };
  }
  let end: CallEnd = { outcome: "cancelled", usage: null };
  try {
    const { res, ms } = await timed(fetchImpl, req);
    if (!res.ok) {
      end = { outcome: "error", errorCode: `http_${res.status}`, notBilled: true };
      return refusal(res, model, provider);
    }
    const body = await res.json().catch(() => null);
    end = { outcome: "ok", usage: probeUsage(provider, body) };
    return { ok: true, latency_ms: ms, model };
  } catch (err) {
    end =
      (err as Error)?.name === "AbortError"
        ? { outcome: "timeout", errorCode: "timeout", usage: null }
        : { outcome: "error", errorCode: "network", usage: null };
    return thrown(err, provider);
  } finally {
    await call.finish(end);
  }
}

async function probeOllama(
  baseUrl: string,
  fetchImpl: FetchImpl,
  saved: string | null,
  meter: ModelCallMeter,
): Promise<ProbeResult> {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  let model: string | null = null;
  try {
    // /v1/models is the OpenAI-compatible list both Ollama and LM Studio serve.
    const { res } = await timed(fetchImpl, { url: `${base}/v1/models`, init: { method: "GET", headers: { accept: "application/json" } } });
    // The list is not about any model: its refusal gets the generic words.
    if (!res.ok) return refusal(res, null, "ollama");
    const list = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const first = list?.data?.find((m) => typeof m?.id === "string" && m.id);
    model = saved || (first ? String(first.id) : null);
  } catch (err) {
    return thrown(err, "ollama");
  }
  if (!model) {
    return { ok: false, code: "no_local_model", message: "The local model server has no models installed yet." };
  }
  const req: ProbeRequest = {
    url: `${base}/v1/chat/completions`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: PROBE_TEXT }] }),
    },
  };
  return meteredProbe("ollama", meter, fetchImpl, req, model, 1);
}

/** How long the department-answer Test waits for a whole reply. */
export const DEPARTMENT_TEST_TIMEOUT_MS = 60_000;

/**
 * Settings > AI brain's "Test" on the SAVED account (app/api/agent-config/
 * test-connection, mode 1): one short department answer, the way a department
 * turn asks for it, through the same request builder (lib/providers.ts
 * streamChat): a department-sized system prompt, an ordinary ask, the
 * department reply budget (lib/os/channel/reply-budget.ts), the same thinking
 * settings. It passes only when the reply has ANSWER TEXT.
 *
 * WHY NOT THE ONE-TOKEN PROBE. A one-token completion proves the key and the
 * model are accepted, and nothing about an answer: on 2026-10-09 Gemini 3.8
 * Flash answered every one-token Test while every department reply came back
 * empty, its whole budget spent thinking. A Test that cannot fail where the
 * departments fail is the false green this file exists to prevent. It costs a
 * few hundred tokens, metered like any call (surface "probe").
 *
 * A local model server (Ollama) keeps the probe above: the cloud cannot reach a
 * server on the operator's machine.
 */
export async function probeDepartmentAnswer(
  provider: Provider,
  key: string,
  opts: { model?: string | null; meter: ModelCallMeter; stream?: typeof streamChat; timeoutMs?: number },
): Promise<ProbeResult> {
  if (provider === "ollama") return probeProvider(provider, key, { model: opts.model, meter: opts.meter });
  const saved = typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : PROBE_MODEL[provider];
  // The model the request really sends (streamChat swaps a gone model the same way).
  const model = resolveModelForCall(provider, saved).model;
  const started = Date.now();
  const it = (opts.stream ?? streamChat)({
    provider,
    model: saved,
    apiKey: key,
    system: DEPARTMENT_TEST_SYSTEM,
    messages: [{ role: "user", content: DEPARTMENT_TEST_ASK }],
    maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
    meter: opts.meter,
  });
  const got: { text: string; failure: string | null } = { text: "", failure: null };
  const read = (async () => {
    for await (const ev of it) {
      if (ev.type === "delta") got.text += ev.text;
      else if (ev.type === "error") {
        got.failure = ev.message;
        break;
      }
    }
    return "read" as const;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    read,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? DEPARTMENT_TEST_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (waited === "timeout") {
    // Close the stream: its meter records the call as cancelled when it ends.
    void it.return(undefined).catch(() => undefined);
    return {
      ok: false,
      code: "timeout",
      message: `The AI model did not finish a short answer within ${Math.round((opts.timeoutMs ?? DEPARTMENT_TEST_TIMEOUT_MS) / 1000)} seconds. Try again in a minute, or pick a faster model.`,
    };
  }
  if (got.failure !== null) {
    const code = classifyStreamError(got.failure);
    const named = code === "provider_404" ? modelFactsForCopy(provider, model) : null;
    return { ok: false, code, message: failureCopy(code, { canManageAi: true, model: named }).sentence };
  }
  if (!got.text.trim()) return { ok: false, code: "reply_empty", message: failureCopy("reply_empty", { canManageAi: true }).sentence };
  return { ok: true, latency_ms: Date.now() - started, model };
}

/**
 * Probe a key (for Ollama, the "key" is the server URL). A 2xx from the
 * one-token completion is the only green.
 */
export async function probeProvider(provider: Provider, key: string, opts: ProbeOptions): Promise<ProbeResult> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const saved = typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : null;
  if (provider === "ollama") return probeOllama(key, fetchImpl, saved, opts.meter);
  // The model the channels really send (lib/ai/model-registry.ts): a saved
  // model the registry knows is gone is tested as its replacement, exactly as
  // every chat sends it, and the probe's ledger row records why.
  const picked = resolveCall(provider, saved ?? PROBE_MODEL[provider], opts.meter);
  const req = buildProbeRequest(provider, key, picked.model);
  return meteredProbe(provider, picked.meter, fetchImpl, req, picked.model, provider === "openrouter" ? OPENROUTER_MIN_MAX_TOKENS : 1);
}
