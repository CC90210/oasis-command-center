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
 */
import "server-only";
import { classifyProviderStatus, failureCopy, type TurnFailureCode } from "@/lib/os/channel/outcome";
import type { Provider } from "@/lib/providers";

export const PROBE_TIMEOUT_MS = 15_000;

/**
 * The cheapest model each provider lists in lib/providers.ts PROVIDER_REGISTRY
 * that is not a reasoning model (a one-token cap on a model that must think
 * first can come back empty or refused for a reason that says nothing about
 * the key).
 */
export const PROBE_MODEL: Record<Exclude<Provider, "ollama">, string> = {
  openrouter: "meta-llama/llama-3.3-70b-instruct",
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.4-mini",
  google: "gemini-2.5-flash",
};

const PROBE_TEXT = "Reply with one word: ok";
/** OpenRouter's floor: "some providers enforce a minimum max_tokens of 16" (its chat-completions docs). */
export const OPENROUTER_MIN_MAX_TOKENS = 16;

export type ProbeRequest = { url: string; init: RequestInit };

export type ProbeResult =
  | { ok: true; latency_ms: number; model: string }
  | { ok: false; code: TurnFailureCode | "timeout" | "network" | "no_local_model"; message: string };

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

type ProbeOptions = {
  /** The model saved with the key; PROBE_MODEL (or Ollama's first) when absent. */
  model?: string | null;
  fetchImpl?: FetchImpl;
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
 */
async function refusal(res: Response, model: string | null): Promise<ProbeResult> {
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
    return { ok: false, code, message: `The model ${model} was not found for this key. Pick another model in AI settings.` };
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

async function probeOllama(baseUrl: string, fetchImpl: FetchImpl, saved: string | null): Promise<ProbeResult> {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  let model: string | null = null;
  try {
    // /v1/models is the OpenAI-compatible list both Ollama and LM Studio serve.
    const { res } = await timed(fetchImpl, { url: `${base}/v1/models`, init: { method: "GET", headers: { accept: "application/json" } } });
    // The list is not about any model: its refusal gets the generic words.
    if (!res.ok) return refusal(res, null);
    const list = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const first = list?.data?.find((m) => typeof m?.id === "string" && m.id);
    model = saved || (first ? String(first.id) : null);
  } catch (err) {
    return thrown(err, "ollama");
  }
  if (!model) {
    return { ok: false, code: "no_local_model", message: "The local model server has no models installed yet." };
  }
  try {
    const { res, ms } = await timed(fetchImpl, {
      url: `${base}/v1/chat/completions`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: PROBE_TEXT }] }),
      },
    });
    return res.ok ? { ok: true, latency_ms: ms, model } : refusal(res, model);
  } catch (err) {
    return thrown(err, "ollama");
  }
}

/**
 * Probe a key (for Ollama, the "key" is the server URL). A 2xx from the
 * one-token completion is the only green.
 */
export async function probeProvider(provider: Provider, key: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const saved = typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : null;
  if (provider === "ollama") return probeOllama(key, fetchImpl, saved);
  const model = saved ?? PROBE_MODEL[provider];
  const req = buildProbeRequest(provider, key, model);
  try {
    const { res, ms } = await timed(fetchImpl, req);
    return res.ok ? { ok: true, latency_ms: ms, model } : refusal(res, model);
  } catch (err) {
    return thrown(err, provider);
  }
}
