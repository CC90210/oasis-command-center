/**
 * What powers your agents, as the browser calls it (components/settings/
 * AgentEnginePanel.tsx): read the choice, switch the AI account's provider to
 * a saved key, test or save an app / local model on the paired computer. Each
 * route tests before it changes anything, and its plain sentence comes back on
 * any failure. No React, so a test drives it without a browser.
 */
import { parseEngineChoice, type AgentEngineChoice, type CliEngine } from "@/lib/ai/agent-engine";
import { machinesOfBody, unsupportedProviders, type CliMachineSnapshot } from "@/lib/bridge-cli-status";
import type { Provider } from "@/lib/providers";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type EngineState = {
  engine: AgentEngineChoice;
  account: { provider: Provider; providerLabel: string; model: string; modelLabel: string } | null;
  savedProviders: Provider[];
  bridgeReachable: boolean;
  canManage: boolean;
  /** OASIS's own workspace: its agents run in their harnesses through the bridge; API keys are the fallback. */
  oasis: boolean;
  /** The saved choice's version (null = none saved); handed back on a save so only the latest choice wins. */
  engineVersion: string | null;
};

const READ_FAILED = "We could not read what powers your agents just now. Refresh to try again.";
const CHANGE_FAILED = "That couldn't be changed just now. Nothing was changed. Try again in a moment.";
const TEST_FAILED = "The test couldn't run just now. Try again in a moment.";
const NO_CONNECTION = "We couldn't reach OASIS just now. Check your connection, then try again. Nothing was changed.";
const SERVER_PROBLEM = "OASIS had a problem answering just now. Nothing was changed. Try again in a moment.";
const TOO_SLOW = "OASIS took too long to answer. Try again, or pick another app. Nothing was changed.";
/** What a stopped call says, by what it was doing. Every one points at the page, which is re-read, as the truth. */
const STOPPED: Record<CallAction, { cancelled: string; deadline: string }> = {
  test: {
    cancelled: "Stopped waiting for the test. Nothing was changed.",
    deadline: "The app on your paired computer didn't answer in time. Try again, or pick another app.",
  },
  save: {
    cancelled: "Stopped waiting. \"In use\" above shows what your agents really run on.",
    deadline: "The app on your paired computer didn't answer in time. Try again, or pick another app. \"In use\" above shows what your agents really run on.",
  },
  switch: {
    cancelled: "Stopped waiting for the provider switch. The AI account shown is what your agents really use.",
    deadline: "The provider didn't answer in time. The AI account shown is what your agents really use. Try again in a moment.",
  },
  remove: {
    cancelled: "Stopped waiting. The saved keys listed show whether it was removed.",
    deadline: "The key couldn't be removed in time. The saved keys listed show whether it was. Try again in a moment.",
  },
};

/**
 * How long the browser waits for the app test (Test or Use this): a little
 * ABOVE the server's own deadline for one short answer
 * (lib/ai/bridge-turn.ts BRIDGE_TEST_TIMEOUT_MS, 75 s), so the server's plain
 * sentence normally arrives first, and a dropped or stalled connection still
 * ends here instead of spinning for good (CC, 2026-10-10: the button sat on
 * "Testing a short answer..." after the server had already answered 422).
 */
export const ENGINE_CLIENT_DEADLINE_MS = 85_000;
/**
 * After a save the browser stopped waiting for (Cancel or the deadline), the
 * server may still be finishing its own test (up to 75 s). The panel reads what
 * is in use once at once and once more after this, so "In use" is never stale.
 */
export const ENGINE_SERVER_WINDOW_MS = 80_000;
/** Reads and quick changes (switch provider, remove a key): nothing on them is slow. */
const QUICK_DEADLINE_MS = 30_000;

export type EngineCallOptions = {
  /** Abort to stop waiting (the panel's Cancel button). */
  signal?: AbortSignal;
  /** Overrides the default deadline; for the app test, ENGINE_CLIENT_DEADLINE_MS. */
  deadlineMs?: number;
};

/** What a call is for, so a stopped one says the right thing. */
type CallAction = "test" | "save" | "switch" | "remove";

type CallResult = { ok: boolean; status: number; body: Record<string, unknown> };

/** Why a call ended without an answer. */
class CallStopped extends Error {
  constructor(readonly why: "deadline" | "cancelled") {
    super(why);
  }
}

/**
 * One JSON call that ALWAYS ends: with the server's answer, or by throwing
 * CallStopped (the deadline passed, or the caller cancelled), or by the
 * network error. The deadline and Cancel cover the body read too, and a fetch
 * that ignores its signal (a stalled connection, a test double) is raced
 * against the same abort, so nothing here can wait forever.
 */
async function call(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  body: unknown,
  opts: EngineCallOptions = {},
): Promise<CallResult> {
  const ctl = new AbortController();
  let why: "deadline" | "cancelled" = "cancelled";
  const stop = (reason: "deadline" | "cancelled") => {
    if (ctl.signal.aborted) return;
    why = reason;
    ctl.abort();
  };
  const timer = setTimeout(() => stop("deadline"), opts.deadlineMs ?? QUICK_DEADLINE_MS);
  const onCancel = () => stop("cancelled");
  if (opts.signal?.aborted) onCancel();
  else opts.signal?.addEventListener("abort", onCancel, { once: true });
  const stopped = new Promise<never>((_, reject) => {
    // Already stopped (a Cancel pressed before the call began): the abort event has fired and will not fire again.
    if (ctl.signal.aborted) reject(new CallStopped(why));
    else ctl.signal.addEventListener("abort", () => reject(new CallStopped(why)), { once: true });
  });
  stopped.catch(() => undefined);
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ctl.signal,
        });
        const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { ok: res.ok && parsed.ok === true, status: res.status, body: parsed };
      })(),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCancel);
  }
}

/** The server's own plain sentence, else one that says what kind of failure it was (never a status code or raw text). */
function failureSentence(r: CallResult, fallback: string): string {
  if (typeof r.body.message === "string" && r.body.message.trim()) return r.body.message;
  if (r.status === 408 || r.status === 504 || r.status === 524) return TOO_SLOW;
  if (r.status >= 500) return SERVER_PROBLEM;
  return fallback;
}

/** What a call that threw means, in one plain sentence. */
function stoppedSentence(err: unknown, fallback: string, action: CallAction): string {
  if (err instanceof CallStopped) return err.why === "cancelled" ? STOPPED[action].cancelled : STOPPED[action].deadline;
  // fetch itself rejected (offline, dropped connection, blocked): not a server answer.
  return err instanceof TypeError ? NO_CONNECTION : fallback;
}

export async function readEngine(
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; state: EngineState } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/ai/engine", "GET", undefined, opts);
    const engine = parseEngineChoice(r.body.engine);
    if (!r.ok || !engine) return { ok: false, message: failureSentence(r, READ_FAILED) };
    const bridge = r.body.bridge as { reachable?: unknown } | undefined;
    return {
      ok: true,
      state: {
        engine,
        account: (r.body.account as EngineState["account"]) ?? null,
        savedProviders: Array.isArray(r.body.savedProviders) ? (r.body.savedProviders as Provider[]) : [],
        bridgeReachable: bridge?.reachable === true,
        canManage: r.body.canManage === true,
        oasis: r.body.workspace === "oasis",
        engineVersion: typeof r.body.engineVersion === "string" ? r.body.engineVersion : null,
      },
    };
  } catch {
    return { ok: false, message: READ_FAILED };
  }
}

/**
 * The apps the paired computer reports the vendor refuses (probe "unsupported",
 * lib/bridge-cli-status.ts unsupportedProviders). A hint for the app picker:
 * when the report cannot be read, nothing is claimed (an empty list).
 */
export async function readUnsupportedApps(fetchImpl: FetchLike = defaultFetch, opts: EngineCallOptions = {}): Promise<CliEngine[]> {
  try {
    const r = await call(fetchImpl, "/api/bridge/cli-status", "GET", undefined, opts);
    if (r.body.ok !== true) return [];
    const machines = machinesOfBody(r.body as { machines?: CliMachineSnapshot[]; data?: unknown });
    return unsupportedProviders(machines);
  } catch {
    return [];
  }
}

/** Save the choice. An app or local model is tested by the route first. */
export async function saveEngine(
  engine: AgentEngineChoice,
  expectedVersion: string | null,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; latencyMs: number | null } | { ok: false; message: string; stopped?: boolean }> {
  try {
    const r = await call(fetchImpl, "/api/ai/engine", "PUT", { engine, expected_version: expectedVersion }, { deadlineMs: ENGINE_CLIENT_DEADLINE_MS, ...opts });
    if (!r.ok) return { ok: false, message: failureSentence(r, CHANGE_FAILED) };
    const test = r.body.test as { latency_ms?: unknown } | undefined;
    return { ok: true, latencyMs: typeof test?.latency_ms === "number" ? test.latency_ms : null };
  } catch (err) {
    return { ok: false, message: stoppedSentence(err, CHANGE_FAILED, "save"), ...(err instanceof CallStopped ? { stopped: true } : {}) };
  }
}

/** Test an app or local model on the paired computer without saving it. */
export async function testEngine(
  engine: AgentEngineChoice,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; latencyMs: number; reply: string } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/ai/engine", "POST", { engine }, { deadlineMs: ENGINE_CLIENT_DEADLINE_MS, ...opts });
    if (!r.ok || typeof r.body.latency_ms !== "number") return { ok: false, message: failureSentence(r, TEST_FAILED) };
    return { ok: true, latencyMs: r.body.latency_ms, reply: typeof r.body.reply === "string" ? r.body.reply : "" };
  } catch (err) {
    return { ok: false, message: stoppedSentence(err, TEST_FAILED, "test") };
  }
}

/**
 * Remove a saved key that is not in use (the team-wide disconnect of that
 * provider: every workspace row on it goes; the account is not on it, so it is
 * untouched). A kept key is never left with no way to remove it.
 */
export async function removeSavedKey(
  provider: Provider,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, `/api/agent-config/bulk-provider?provider=${encodeURIComponent(provider)}`, "DELETE", undefined, opts);
    return r.ok ? { ok: true } : { ok: false, message: failureSentence(r, CHANGE_FAILED) };
  } catch (err) {
    return { ok: false, message: stoppedSentence(err, CHANGE_FAILED, "remove") };
  }
}

/** Move the AI account to another provider whose key is saved (tested first by the route). */
export async function switchProvider(
  provider: Provider,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; label: string } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/agent-config/workspace-provider", "POST", { provider }, { deadlineMs: 60_000, ...opts });
    if (!r.ok) return { ok: false, message: failureSentence(r, CHANGE_FAILED) };
    return { ok: true, label: typeof r.body.label === "string" ? r.body.label : provider };
  } catch (err) {
    return { ok: false, message: stoppedSentence(err, CHANGE_FAILED, "switch") };
  }
}
