/**
 * What powers your agents, as the browser calls it (components/settings/
 * AgentEnginePanel.tsx): read the choice, switch the AI account's provider to
 * a saved key, test or save an app / local model on the paired computer. Each
 * route tests before it changes anything, and its plain sentence comes back on
 * any failure. No React, so a test drives it without a browser.
 */
import { parseEngineChoice, type AgentEngineChoice } from "@/lib/ai/agent-engine";
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
};

const READ_FAILED = "We could not read what powers your agents just now. Refresh to try again.";
const CHANGE_FAILED = "That couldn't be changed just now. Nothing was changed. Try again in a moment.";

async function call(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  body: unknown,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && parsed.ok === true, body: parsed };
}

const sentence = (body: Record<string, unknown>, fallback: string) =>
  typeof body.message === "string" && body.message.trim() ? body.message : fallback;

export async function readEngine(fetchImpl: FetchLike = defaultFetch): Promise<{ ok: true; state: EngineState } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/ai/engine", "GET", undefined);
    const engine = parseEngineChoice(r.body.engine);
    if (!r.ok || !engine) return { ok: false, message: sentence(r.body, READ_FAILED) };
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
      },
    };
  } catch {
    return { ok: false, message: READ_FAILED };
  }
}

/** Save the choice. An app or local model is tested by the route first. */
export async function saveEngine(
  engine: AgentEngineChoice,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ ok: true; latencyMs: number | null } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/ai/engine", "PUT", { engine });
    if (!r.ok) return { ok: false, message: sentence(r.body, CHANGE_FAILED) };
    const test = r.body.test as { latency_ms?: unknown } | undefined;
    return { ok: true, latencyMs: typeof test?.latency_ms === "number" ? test.latency_ms : null };
  } catch {
    return { ok: false, message: CHANGE_FAILED };
  }
}

/** Test an app or local model on the paired computer without saving it. */
export async function testEngine(
  engine: AgentEngineChoice,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ ok: true; latencyMs: number; reply: string } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/ai/engine", "POST", { engine });
    if (!r.ok || typeof r.body.latency_ms !== "number") return { ok: false, message: sentence(r.body, "The test couldn't run just now. Try again in a moment.") };
    return { ok: true, latencyMs: r.body.latency_ms, reply: typeof r.body.reply === "string" ? r.body.reply : "" };
  } catch {
    return { ok: false, message: "The test couldn't run just now. Try again in a moment." };
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
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, `/api/agent-config/bulk-provider?provider=${encodeURIComponent(provider)}`, "DELETE", undefined);
    return r.ok ? { ok: true } : { ok: false, message: sentence(r.body, CHANGE_FAILED) };
  } catch {
    return { ok: false, message: CHANGE_FAILED };
  }
}

/** Move the AI account to another provider whose key is saved (tested first by the route). */
export async function switchProvider(
  provider: Provider,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ ok: true; label: string } | { ok: false; message: string }> {
  try {
    const r = await call(fetchImpl, "/api/agent-config/workspace-provider", "POST", { provider });
    if (!r.ok) return { ok: false, message: sentence(r.body, CHANGE_FAILED) };
    return { ok: true, label: typeof r.body.label === "string" ? r.body.label : provider };
  } catch {
    return { ok: false, message: CHANGE_FAILED };
  }
}
