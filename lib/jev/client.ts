/**
 * lib/jev/client.ts - a server-side client for Jev, TypeSafe's System One
 * model: ask it "which of these labels" (Choice) or "how much, on this scale"
 * (Score) about a piece of text, and get back values and confidences.
 *
 * THE WIRE CONTRACT IS THE SDK'S, NOT A GUESS. Endpoint, auth header, request
 * and response shapes are read from the installed typesafe-sdk 0.7.1 source
 * (Business-Empire-Agent .venv, site-packages/typesafe_sdk):
 *   base URL        https://api.typesafe.ai            (constants.py DEFAULT_BASE_URL)
 *   classify        POST /v1/systemone                 (_core/constants.py SYSTEM_ONE_PATH)
 *   list models     GET  /v1/models                    (_core/constants.py MODELS_PATH)
 *   auth            Authorization: Bearer <key>        (_core/transport.py prepare)
 *   default model   jev-latest                         (constants.py DEFAULT_MODEL)
 *   request         { state, model, questions: { name: { type, instructions?, criteria } } }
 *                                                      (_core/endpoints.py prepare_system_one,
 *                                                       _schemas/models.py SystemOneRequest)
 *   response        { model, answers: { name: { type: "choice", choice, confidence,
 *                     probabilities } | { type: "score", score, confidence, legend,
 *                     probabilities } }, usage: { input_tokens, output_tokens } }
 *                                                      (_schemas/models.py SystemOneResponse)
 *
 * BOUNDED AND NEVER THROWING PAST THE CALLER.
 *   - Each attempt is aborted at JEV_TIMEOUT_MS (2 s).
 *   - Retries ONLY on 429 and 5xx, at most once, and only when the wait fits
 *     inside the call's budget (2 x timeout); a longer Retry-After is not slept.
 *     A timeout or a network error is not retried: two seconds lost is enough.
 *   - Every failure comes back as a structured result with a failure code. The
 *     key, the text sent, and TypeSafe's error body are never in it.
 *
 * WHAT IT IS FOR. Jev's answer is DATA. The caller (lib/jev/mode.ts) records it
 * beside the decision OASIS already made; nothing here, and nothing that calls
 * this, may send, change or approve anything because of what Jev said.
 */
import "server-only";

export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_SYSTEM_ONE_PATH = "/v1/systemone";
export const JEV_MODELS_PATH = "/v1/models";
export const JEV_DEFAULT_MODEL = "jev-latest";
/** One attempt's deadline. */
export const JEV_TIMEOUT_MS = 2_000;
/** Retries after the first attempt, for 429 / 5xx only. */
export const JEV_MAX_RETRIES = 1;
/** The key probe (list models) may take longer than a classification. */
export const JEV_PROBE_TIMEOUT_MS = 5_000;

export type JevChoiceQuestion = {
  type: "choice";
  instructions?: string;
  /** Label -> when it applies (null = the label alone). */
  criteria: Record<string, string | null>;
};

export type JevScoreQuestion = {
  type: "score";
  instructions?: string;
  /** Level descriptions, lowest first; the index is the score. */
  criteria: string[];
};

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion;

export type JevChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type JevScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer;

export type JevFailure =
  | "invalid_input"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "auth_failed"
  | "bad_request"
  | "server_error"
  | "schema_mismatch";

export type JevResult =
  | {
      ok: true;
      model: string;
      answers: Record<string, JevAnswer>;
      usage: { inputTokens: number | null; outputTokens: number | null };
      latencyMs: number;
      attempts: number;
    }
  | { ok: false; failure: JevFailure; status: number | null; latencyMs: number; attempts: number };

export type JevFetch = typeof fetch;

export type JevCallOpts = {
  fetchImpl?: JevFetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test seam for the retry wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-enough clock for latency (tests pin it). */
  clock?: () => number;
  baseUrl?: string;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function headers(apiKey: string, withBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: "application/json",
    ...(withBody ? { "content-type": "application/json" } : {}),
    "user-agent": "oasis-command-center",
  };
}

/** Validate the questions the way the SDK does before encoding (_core/questions.py). */
export function questionsAreValid(questions: Record<string, JevQuestion>): boolean {
  const names = Object.keys(questions);
  if (names.length === 0) return false;
  for (const name of names) {
    const q = questions[name];
    if (!q || (q.type !== "choice" && q.type !== "score")) return false;
    if (q.type === "choice" && Object.keys(q.criteria ?? {}).length < 2) return false;
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length === 0)) return false;
  }
  return true;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function probabilities(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    const n = num(p);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

/**
 * Parse a 2xx body against the questions asked. Every question must have an
 * answer of its own type, and a choice must be one of the labels offered:
 * anything else is schema_mismatch, never a best guess.
 */
export function parseSystemOneResponse(
  body: unknown,
  questions: Record<string, JevQuestion>,
): { model: string; answers: Record<string, JevAnswer>; usage: { inputTokens: number | null; outputTokens: number | null } } | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.model !== "string") return null;
  const raw = o.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = (raw as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
    if (!a || typeof a !== "object" || a.type !== q.type) return null;
    const confidence = num(a.confidence);
    const probs = probabilities(a.probabilities);
    if (confidence === null || probs === null) return null;
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !Object.prototype.hasOwnProperty.call(q.criteria, a.choice)) return null;
      answers[name] = { type: "choice", choice: a.choice, confidence, probabilities: probs };
    } else {
      const score = num(a.score);
      if (score === null) return null;
      answers[name] = { type: "score", score, confidence, probabilities: probs };
    }
  }
  const usage = (o.usage && typeof o.usage === "object" ? o.usage : {}) as Record<string, unknown>;
  return {
    model: o.model,
    answers,
    usage: { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) },
  };
}

function failureForStatus(status: number): JevFailure {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_request";
}

function retryAfterMs(res: Response): number | null {
  const ms = Number(res.headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0 && res.headers.get("retry-after-ms") !== null) return ms;
  const sec = Number(res.headers.get("retry-after"));
  if (Number.isFinite(sec) && sec >= 0 && res.headers.get("retry-after") !== null) return sec * 1000;
  return null;
}

/**
 * Classify `state` with `questions`. Never throws: every outcome, including a
 * bad input, is a JevResult.
 */
export async function classify(
  input: { apiKey: string; state: string | Record<string, unknown>; questions: Record<string, JevQuestion>; model?: string },
  opts: JevCallOpts = {},
): Promise<JevResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  const maxRetries = Math.max(0, Math.min(JEV_MAX_RETRIES, opts.maxRetries ?? JEV_MAX_RETRIES));
  const budgetMs = timeoutMs * 2;
  const sleep = opts.sleep ?? realSleep;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const elapsed = () => Math.max(0, Math.round(clock() - started));

  const apiKey = (input.apiKey || "").trim();
  const stateOk = typeof input.state === "string" ? input.state.trim().length > 0 : !!input.state && typeof input.state === "object";
  if (!apiKey || !stateOk || !questionsAreValid(input.questions)) {
    return { ok: false, failure: "invalid_input", status: null, latencyMs: 0, attempts: 0 };
  }
  const body = JSON.stringify({ state: input.state, model: input.model ?? JEV_DEFAULT_MODEL, questions: input.questions });

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl ?? JEV_BASE_URL}${JEV_SYSTEM_ONE_PATH}`, {
        method: "POST",
        headers: headers(apiKey, true),
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      return { ok: false, failure: aborted ? "timeout" : "network_error", status: null, latencyMs: elapsed(), attempts };
    }
    let parsedBody: unknown = null;
    let bodyReadable = true;
    try {
      parsedBody = await res.json();
    } catch (err) {
      bodyReadable = false;
      if (err instanceof Error && err.name === "AbortError") {
        clearTimeout(timer);
        return { ok: false, failure: "timeout", status: res.status, latencyMs: elapsed(), attempts };
      }
    }
    clearTimeout(timer);

    if (res.ok) {
      const parsed = bodyReadable ? parseSystemOneResponse(parsedBody, input.questions) : null;
      if (!parsed) return { ok: false, failure: "schema_mismatch", status: res.status, latencyMs: elapsed(), attempts };
      return { ok: true, ...parsed, latencyMs: elapsed(), attempts };
    }

    const failure = failureForStatus(res.status);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempts > maxRetries) {
      return { ok: false, failure, status: res.status, latencyMs: elapsed(), attempts };
    }
    const wait = retryAfterMs(res) ?? 250;
    // The retry must fit the call's budget, wait included, or it is not made.
    if (elapsed() + wait + timeoutMs > budgetMs) {
      return { ok: false, failure, status: res.status, latencyMs: elapsed(), attempts };
    }
    await sleep(wait);
  }
}

export type JevProbe = {
  verdict: "healthy" | "down" | "unknown";
  code: "key_rejected" | "provider_unreachable" | "unexpected_response" | null;
  detail: string | null;
  latencyMs: number;
  /** Models the key may use, when TypeSafe listed them. */
  models: string[];
};

/**
 * Check a key without sending any data: list the models it may use
 * (GET /v1/models). 200 with a model list = healthy; 401/403 = the key is
 * refused; a timeout, network error, 429 or 5xx = nothing concluded.
 */
export async function probeJevKey(apiKey: string, opts: JevCallOpts = {}): Promise<JevProbe> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const elapsed = () => Math.max(0, Math.round(clock() - started));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? JEV_PROBE_TIMEOUT_MS);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? JEV_BASE_URL}${JEV_MODELS_PATH}`, {
      method: "GET",
      headers: headers(apiKey.trim(), false),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { verdict: "down", code: "key_rejected", detail: "TypeSafe refused this key.", latencyMs: elapsed(), models: [] };
    }
    if (res.status === 429 || res.status >= 500) {
      return {
        verdict: "unknown",
        code: "provider_unreachable",
        detail: `TypeSafe did not answer the check (HTTP ${res.status}). OASIS will check again.`,
        latencyMs: elapsed(),
        models: [],
      };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const list = body && typeof body === "object" ? (body as Record<string, unknown>).models : null;
    if (!res.ok || !Array.isArray(list)) {
      return {
        verdict: "unknown",
        code: "unexpected_response",
        detail: `TypeSafe answered the check in a way OASIS does not understand (HTTP ${res.status}).`,
        latencyMs: elapsed(),
        models: [],
      };
    }
    const models = list
      .map((m) => (m && typeof m === "object" && typeof (m as Record<string, unknown>).name === "string" ? String((m as Record<string, unknown>).name) : null))
      .filter((m): m is string => Boolean(m));
    return { verdict: "healthy", code: null, detail: null, latencyMs: elapsed(), models };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      verdict: "unknown",
      code: "provider_unreachable",
      detail: aborted ? "TypeSafe did not answer the check in time. OASIS will check again." : "OASIS could not reach TypeSafe. It will check again.",
      latencyMs: elapsed(),
      models: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
