/**
 * Browser contract for Settings > AI brain.
 *
 * New writes use one explicit EngineSelection. During rollout, GET and the
 * legacy test helpers still accept the old {kind:"cli"|"local"|"api"}
 * choice so an older server cannot strand Settings.
 */
import {
  isApiEngineProvider,
  parseEngineChoice,
  parseEngineSelection as parseCanonicalEngineSelection,
  type AgentEngineChoice,
  type ApiEngineProvider,
  type CliEngine,
  type EngineSelection,
} from "@/lib/ai/agent-engine";
import { machinesOfBody, unsupportedProviders, type CliMachineSnapshot } from "@/lib/bridge-cli-status";
import { bridgeHostOSFromPlatform, bridgeRestartCommand } from "@/lib/bridge-install-guidance";
import type { Provider } from "@/lib/providers";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type EngineScope = "person" | "workspace";
export type { EngineFallback, EngineSelection } from "@/lib/ai/agent-engine";

export type DeviceRuntime = {
  installed: boolean;
  signedIn: boolean;
  executionReady: boolean;
  unsupported: boolean;
  version: string | null;
  lastTestedAt: string | null;
  code: string | null;
};

export type EngineDevice = {
  pairingId: string;
  label: string;
  ownerName: string | null;
  ownedByViewer: boolean;
  /** True only when this pairing belongs to the workspace's configured agents owner. */
  workspaceEligible: boolean;
  /** False when a legacy daemon-scoped pairing is owned by somebody other
   * than the workspace agents owner; claim routes reject it. */
  agentClaimEligible: boolean;
  os: string | null;
  lastSeenAt: string | null;
  approved: boolean;
  online: boolean;
  busy: boolean;
  protocols: string[];
  runtimes: Record<CliEngine, DeviceRuntime>;
  localModels: Array<{
    ref: string;
    label: string;
    adapter: "ollama" | "lmstudio";
    state: "ready" | "unavailable" | "probe_required";
    lastTestedAt: string | null;
  }>;
};

export type EngineState = {
  engine: EngineSelection;
  personEngine: { source: "workspace" | "person"; selection: EngineSelection | null };
  devices: EngineDevice[];
  account: { provider: ApiEngineProvider; providerLabel: string; model: string; modelLabel: string } | null;
  savedProviders: ApiEngineProvider[];
  bridgeReachable: boolean;
  canManage: boolean;
  oasis: boolean;
  engineVersion: string | null;
  engineVersions: { person: string | null; workspace: string | null };
};

export type RuntimeJob = {
  id: string;
  status: "queued" | "claimed" | "running" | "waiting_user" | "done" | "failed";
  action: string;
  engine: { kind: string; name: string } | null;
  errorCode: string | null;
  message: string | null;
  result: { reply?: string; latencyMs?: number; instructions?: string; authUrl?: string } | null;
};

const READ_FAILED = "We could not read what powers your agents just now. Refresh to try again.";
const CHANGE_FAILED = "That couldn't be changed just now. Nothing was changed. Try again in a moment.";
const TEST_FAILED = "The test couldn't run just now. Try again in a moment.";
const NO_CONNECTION = "We couldn't reach OASIS just now. Check your connection, then try again. Nothing was changed.";
const SERVER_PROBLEM = "OASIS had a problem answering just now. Nothing was changed. Try again in a moment.";
const TOO_SLOW = "OASIS took too long to answer. Try again, or pick another app. Nothing was changed.";

type CallAction = "test" | "save" | "switch" | "remove";
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

export const ENGINE_CLIENT_DEADLINE_MS = 85_000;
export const ENGINE_SERVER_WINDOW_MS = 80_000;
/** Connector probes may legitimately run for 540 s. Keep the browser alive
 * for that full restricted inference plus one minute of queue/network margin;
 * its Stop button still cancels immediately. */
export const CONNECTOR_PROBE_MAX_MS = 540_000;
export const RUNTIME_JOB_DEADLINE_MS = CONNECTOR_PROBE_MAX_MS + 60_000;
const QUICK_DEADLINE_MS = 30_000;

export type EngineCallOptions = {
  signal?: AbortSignal;
  deadlineMs?: number;
};

export type SaveEngineOptions = EngineCallOptions & {
  scope?: EngineScope;
  probeJobId?: string;
};

type CallResult = { ok: boolean; status: number; body: Record<string, unknown> };

class CallStopped extends Error {
  constructor(readonly why: "deadline" | "cancelled") {
    super(why);
  }
}

async function call(fetchImpl: FetchLike, url: string, method: string, body: unknown, opts: EngineCallOptions = {}): Promise<CallResult> {
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

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isProvider(value: unknown): value is ApiEngineProvider {
  return isApiEngineProvider(value);
}

export function parseEngineSelection(raw: unknown, fallbackProvider: ApiEngineProvider = "anthropic"): EngineSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const canonical = parseCanonicalEngineSelection(raw);
  if (canonical) return canonical;
  const value = raw as Record<string, unknown>;
  // Rollout compatibility with the old workspace-wide choice.
  const legacy = parseEngineChoice(raw);
  if (legacy?.kind === "api") return { mode: "api", provider: legacy.provider ?? fallbackProvider };
  if (legacy?.kind === "cli") {
    const pairingId = legacy.pairingId ?? nonEmpty(value.pairing_id) ?? "";
    return { mode: "subscription", pairingId, provider: legacy.cli, fallback: legacy.fallback ?? "none" };
  }
  if (legacy?.kind === "local") {
    const pairingId = legacy.pairingId ?? nonEmpty(value.pairing_id) ?? "";
    return { mode: "local", pairingId, modelRef: legacy.model, fallback: legacy.fallback ?? "none" };
  }
  return null;
}

function runtime(raw: unknown): DeviceRuntime {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    installed: value.installed === true,
    signedIn: value.signedIn === true || value.signed_in === true || value.authenticated === true,
    executionReady: value.executionReady === true || value.execution_ready === true,
    unsupported: value.unsupported === true || value.code === "unsupported_personal_sign_in",
    version: nonEmpty(value.version),
    lastTestedAt: nonEmpty(value.lastTestedAt) ?? nonEmpty(value.last_tested_at),
    code: nonEmpty(value.code),
  };
}

function device(raw: unknown): EngineDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const pairingId = nonEmpty(value.pairingId) ?? nonEmpty(value.pairing_id) ?? nonEmpty(value.id);
  if (!pairingId) return null;
  const runtimes = value.runtimes && typeof value.runtimes === "object" ? (value.runtimes as Record<string, unknown>) : {};
  const models = Array.isArray(value.localModels) ? value.localModels : Array.isArray(value.local_models) ? value.local_models : [];
  return {
    pairingId,
    label: nonEmpty(value.label) ?? "Paired computer",
    ownerName: nonEmpty(value.ownerName) ?? nonEmpty(value.owner_name),
    ownedByViewer: value.ownedByViewer === true || value.owned_by_viewer === true,
    workspaceEligible: value.workspaceEligible === true || value.workspace_eligible === true,
    agentClaimEligible:
      !Object.prototype.hasOwnProperty.call(value, "agentClaimEligible") &&
      !Object.prototype.hasOwnProperty.call(value, "agent_claim_eligible")
        ? true
        : value.agentClaimEligible === true || value.agent_claim_eligible === true,
    os: nonEmpty(value.os),
    lastSeenAt: nonEmpty(value.lastSeenAt) ?? nonEmpty(value.last_seen_at),
    approved: value.approved === true,
    online: value.online === true,
    busy: value.busy === true,
    protocols: Array.isArray(value.protocols) ? value.protocols.filter((item): item is string => typeof item === "string") : [],
    runtimes: { claude: runtime(runtimes.claude), codex: runtime(runtimes.codex), gemini: runtime(runtimes.gemini) },
    localModels: models.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const model = item as Record<string, unknown>;
      const ref = nonEmpty(model.ref);
      const adapter = model.adapter === "ollama" || model.adapter === "lmstudio" ? model.adapter : null;
      if (!ref || !adapter) return [];
      const state = model.state === "ready" || model.state === "unavailable" || model.state === "probe_required" ? model.state : "probe_required";
      return [{
        ref,
        label: nonEmpty(model.label) ?? ref,
        adapter,
        state,
        lastTestedAt: nonEmpty(model.lastTestedAt) ?? nonEmpty(model.last_tested_at),
      }];
    }),
  };
}

/** The scope picker never offers a teammate's computer for a personal row or a non-owner computer for the workspace row. */
export function engineDevicesForScope(devices: EngineDevice[], scope: EngineScope): EngineDevice[] {
  return devices.filter((item) => (scope === "person" ? item.ownedByViewer : item.workspaceEligible));
}

function failureSentence(result: CallResult, fallback: string): string {
  if (typeof result.body.message === "string" && result.body.message.trim()) return result.body.message;
  if (result.status === 408 || result.status === 504 || result.status === 524) return TOO_SLOW;
  if (result.status >= 500) return SERVER_PROBLEM;
  return fallback;
}

function failureCode(result: CallResult): string | undefined {
  return nonEmpty(result.body.errorCode) ?? nonEmpty(result.body.error_code) ?? nonEmpty(result.body.code) ?? undefined;
}

function stoppedSentence(error: unknown, fallback: string, action: CallAction): string {
  if (error instanceof CallStopped) return error.why === "cancelled" ? STOPPED[action].cancelled : STOPPED[action].deadline;
  return error instanceof TypeError ? NO_CONNECTION : fallback;
}

export async function readEngine(
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; state: EngineState } | { ok: false; message: string }> {
  try {
    const result = await call(fetchImpl, "/api/ai/engine", "GET", undefined, opts);
    const account = (result.body.account as EngineState["account"]) ?? null;
    const defaultProvider: ApiEngineProvider = account && isProvider(account.provider) ? account.provider : "anthropic";
    const selection = parseEngineSelection(result.body.engine, defaultProvider);
    if (!result.ok || !selection) return { ok: false, message: failureSentence(result, READ_FAILED) };
    const rawPerson = result.body.personEngine && typeof result.body.personEngine === "object" ? (result.body.personEngine as Record<string, unknown>) : null;
    const source = rawPerson?.source === "person" ? "person" : "workspace";
    const personSelection = rawPerson ? parseEngineSelection(rawPerson.selection, defaultProvider) : null;
    const bridge = result.body.bridge as { reachable?: unknown } | undefined;
    const versions = result.body.engineVersions && typeof result.body.engineVersions === "object"
      ? (result.body.engineVersions as Record<string, unknown>)
      : null;
    const legacyVersion = nonEmpty(result.body.engineVersion);
    return {
      ok: true,
      state: {
        engine: selection,
        personEngine: { source, selection: personSelection },
        devices: Array.isArray(result.body.devices) ? result.body.devices.flatMap((item) => device(item) ?? []) : [],
        account,
        savedProviders: Array.isArray(result.body.savedProviders) ? result.body.savedProviders.filter(isProvider) : [],
        bridgeReachable: bridge?.reachable === true || (Array.isArray(result.body.devices) && result.body.devices.some((item) => device(item)?.online)),
        canManage: result.body.canManage === true,
        oasis: result.body.workspace === "oasis",
        engineVersion: legacyVersion,
        engineVersions: {
          person: versions && Object.prototype.hasOwnProperty.call(versions, "person") ? nonEmpty(versions.person) : legacyVersion,
          workspace: versions && Object.prototype.hasOwnProperty.call(versions, "workspace") ? nonEmpty(versions.workspace) : legacyVersion,
        },
      },
    };
  } catch {
    return { ok: false, message: READ_FAILED };
  }
}

/** Rollout helper retained for callers that still read the old CLI inventory route. */
export async function readUnsupportedApps(fetchImpl: FetchLike = defaultFetch, opts: EngineCallOptions = {}): Promise<CliEngine[]> {
  try {
    const result = await call(fetchImpl, "/api/bridge/cli-status", "GET", undefined, opts);
    if (result.body.ok !== true) return [];
    const machines = machinesOfBody(result.body as { machines?: CliMachineSnapshot[]; data?: unknown });
    return unsupportedProviders(machines);
  } catch {
    return [];
  }
}

function isSelection(value: EngineSelection | AgentEngineChoice): value is EngineSelection {
  return "mode" in value;
}

export async function queueEngineProbe(
  engine: EngineSelection,
  scope: EngineScope,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; jobId: string } | { ok: false; message: string; code?: string }> {
  try {
    const result = await call(fetchImpl, "/api/ai/engine", "POST", { engine, scope }, { deadlineMs: ENGINE_CLIENT_DEADLINE_MS, ...opts });
    const jobId = nonEmpty(result.body.job_id) ?? nonEmpty(result.body.jobId);
    if (!(result.ok || (result.status === 202 && jobId)) || !jobId) {
      const code = failureCode(result);
      return { ok: false, message: failureSentence(result, TEST_FAILED), ...(code ? { code } : {}) };
    }
    return { ok: true, jobId };
  } catch (error) {
    return { ok: false, message: stoppedSentence(error, TEST_FAILED, "test") };
  }
}

function parseRuntimeJob(raw: unknown): RuntimeJob | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = nonEmpty(value.id) ?? nonEmpty(value.job_id);
  const statuses = ["queued", "claimed", "running", "waiting_user", "done", "failed"];
  const progress = value.progress && typeof value.progress === "object" ? (value.progress as Record<string, unknown>) : null;
  const rawStatus = value.status === "completed" ? "done" : progress?.code === "waiting_for_user" ? "waiting_user" : value.status;
  const status = typeof rawStatus === "string" && statuses.includes(rawStatus) ? (rawStatus as RuntimeJob["status"]) : null;
  if (!id || !status) return null;
  const rawEngine = value.engine && typeof value.engine === "object" ? (value.engine as Record<string, unknown>) : null;
  const rawResult = value.result && typeof value.result === "object" ? (value.result as Record<string, unknown>) : null;
  const rawError = value.error && typeof value.error === "object" ? (value.error as Record<string, unknown>) : null;
  return {
    id,
    status,
    action: nonEmpty(value.action) ?? "runtime",
    engine: rawEngine ? { kind: nonEmpty(rawEngine.kind) ?? "runtime", name: nonEmpty(rawEngine.name) ?? "runtime" } : null,
    errorCode: nonEmpty(value.errorCode) ?? nonEmpty(value.error_code) ?? nonEmpty(rawError?.code),
    message: nonEmpty(value.message),
    result: rawResult
      ? {
          ...(nonEmpty(rawResult.reply) || nonEmpty(rawResult.answer) ? { reply: nonEmpty(rawResult.reply) ?? nonEmpty(rawResult.answer)! } : {}),
          ...(typeof rawResult.latency_ms === "number" ? { latencyMs: rawResult.latency_ms } : {}),
          ...(nonEmpty(rawResult.instructions) ? { instructions: nonEmpty(rawResult.instructions)! } : {}),
          ...(nonEmpty(rawResult.auth_url) || nonEmpty(rawResult.authUrl) ? { authUrl: nonEmpty(rawResult.auth_url) ?? nonEmpty(rawResult.authUrl)! } : {}),
        }
      : null,
  };
}

export async function readRuntimeJob(
  jobId: string,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; job: RuntimeJob } | { ok: false; message: string; code?: string }> {
  try {
    const result = await call(fetchImpl, `/api/bridge/runtime-jobs/${encodeURIComponent(jobId)}`, "GET", undefined, opts);
    const job = parseRuntimeJob(result.body.job);
    if (!result.ok || !job) {
      const code = failureCode(result);
      return { ok: false, message: failureSentence(result, TEST_FAILED), ...(code ? { code } : {}) };
    }
    return { ok: true, job };
  } catch (error) {
    return { ok: false, message: stoppedSentence(error, TEST_FAILED, "test") };
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CallStopped("cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CallStopped("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollRuntimeJob(
  jobId: string,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions & { intervalMs?: number; onUpdate?: (job: RuntimeJob) => void } = {},
): Promise<{ ok: true; job: RuntimeJob } | { ok: false; message: string; code?: string }> {
  const started = Date.now();
  const deadline = opts.deadlineMs ?? RUNTIME_JOB_DEADLINE_MS;
  while (Date.now() - started < deadline) {
    const current = await readRuntimeJob(jobId, fetchImpl, opts);
    if (!current.ok) return current;
    opts.onUpdate?.(current.job);
    if (current.job.status === "done") return current;
    if (current.job.status === "failed") {
      return {
        ok: false,
        message: current.job.message ?? "The computer could not finish that action.",
        ...(current.job.errorCode ? { code: current.job.errorCode } : {}),
      };
    }
    try {
      await wait(opts.intervalMs ?? 1_500, opts.signal);
    } catch (error) {
      return { ok: false, message: stoppedSentence(error, TEST_FAILED, "test") };
    }
  }
  return { ok: false, message: TOO_SLOW, code: "runtime_job_timeout" };
}

export async function saveEngine(
  engine: EngineSelection | AgentEngineChoice,
  expectedVersion: string | null,
  fetchImpl: FetchLike = defaultFetch,
  opts: SaveEngineOptions = {},
): Promise<{ ok: true; latencyMs: number | null } | { ok: false; message: string; code?: string; stopped?: boolean }> {
  try {
    const body = isSelection(engine)
      ? {
          engine,
          scope: opts.scope ?? "person",
          expected_version: expectedVersion,
          ...(opts.probeJobId ? { probe_job_id: opts.probeJobId } : {}),
        }
      : { engine, expected_version: expectedVersion };
    const result = await call(fetchImpl, "/api/ai/engine", "PUT", body, { deadlineMs: ENGINE_CLIENT_DEADLINE_MS, ...opts });
    if (!result.ok) {
      const code = failureCode(result);
      return { ok: false, message: failureSentence(result, CHANGE_FAILED), ...(code ? { code } : {}) };
    }
    const test = result.body.test as { latency_ms?: unknown } | undefined;
    return { ok: true, latencyMs: typeof test?.latency_ms === "number" ? test.latency_ms : null };
  } catch (error) {
    return {
      ok: false,
      message: stoppedSentence(error, CHANGE_FAILED, "save"),
      ...(error instanceof CallStopped ? { stopped: true } : {}),
    };
  }
}

export async function inheritWorkspaceEngine(
  expectedVersion: string | null,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  try {
    const result = await call(
      fetchImpl,
      "/api/ai/engine",
      "PUT",
      { scope: "person", use_workspace_default: true, expected_version: expectedVersion },
      opts,
    );
    if (result.ok) return { ok: true };
    const code = failureCode(result);
    return { ok: false, message: failureSentence(result, CHANGE_FAILED), ...(code ? { code } : {}) };
  } catch (error) {
    return { ok: false, message: stoppedSentence(error, CHANGE_FAILED, "save") };
  }
}

/** Legacy synchronous helper retained until every caller moves to queued jobs. */
export async function testEngine(
  engine: AgentEngineChoice,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; latencyMs: number; reply: string } | { ok: false; message: string; code?: string }> {
  try {
    const result = await call(fetchImpl, "/api/ai/engine", "POST", { engine }, { deadlineMs: ENGINE_CLIENT_DEADLINE_MS, ...opts });
    if (!result.ok || typeof result.body.latency_ms !== "number") {
      const code = failureCode(result);
      return { ok: false, message: failureSentence(result, TEST_FAILED), ...(code ? { code } : {}) };
    }
    return { ok: true, latencyMs: result.body.latency_ms, reply: typeof result.body.reply === "string" ? result.body.reply : "" };
  } catch (error) {
    return { ok: false, message: stoppedSentence(error, TEST_FAILED, "test") };
  }
}

export async function removeSavedKey(
  provider: Provider,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const result = await call(fetchImpl, `/api/agent-config/bulk-provider?provider=${encodeURIComponent(provider)}`, "DELETE", undefined, opts);
    return result.ok ? { ok: true } : { ok: false, message: failureSentence(result, CHANGE_FAILED) };
  } catch (error) {
    return { ok: false, message: stoppedSentence(error, CHANGE_FAILED, "remove") };
  }
}

export async function switchProvider(
  provider: Provider,
  fetchImpl: FetchLike = defaultFetch,
  opts: EngineCallOptions = {},
): Promise<{ ok: true; label: string } | { ok: false; message: string }> {
  try {
    const result = await call(fetchImpl, "/api/agent-config/workspace-provider", "POST", { provider }, { deadlineMs: 60_000, ...opts });
    if (!result.ok) return { ok: false, message: failureSentence(result, CHANGE_FAILED) };
    return { ok: true, label: typeof result.body.label === "string" ? result.body.label : provider };
  } catch (error) {
    return { ok: false, message: stoppedSentence(error, CHANGE_FAILED, "switch") };
  }
}

const CLI_LABEL: Record<CliEngine, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
const CLI_INSTALL: Record<CliEngine, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @google/gemini-cli",
};
const CLI_LOGIN: Record<CliEngine, string> = { claude: "claude\n/login", codex: "codex login", gemini: "Use a Google API key" };

/** Copy-safe launcher command for the exact paired computer. The launcher
 * delegates to that OS's registered supervisor, rather than starting an
 * unmanaged duplicate bridge process. */
export function connectorRestartCommand(platform: string | null | undefined): string {
  const hostOS = bridgeHostOSFromPlatform(platform);
  return hostOS ? bridgeRestartCommand(hostOS) : "oasis bridge restart";
}

/** One truthful status sentence. A heartbeat/sign-in alone is deliberately never called ready. */
export function describeRuntime(
  target: Pick<EngineDevice, "label" | "os" | "approved" | "online" | "busy" | "protocols" | "runtimes" | "agentClaimEligible">,
  provider: CliEngine,
): { label: string; verified: boolean; repair: string | null } {
  const state = target.runtimes[provider];
  const name = CLI_LABEL[provider];
  const code = state.code?.toLowerCase() ?? null;
  const notInstalledCodes = new Set(["not_installed", "cli_not_found"]);
  const unsupportedCodes = new Set(["unsupported", "unsupported_personal_sign_in", "account_unsupported"]);
  const signInCodes = new Set([
    "needs_sign_in",
    "auth_required",
    "authentication_failed",
    "cli_auth_required",
    "auth_process_failed",
    "auth_start_failed",
    "auth_timeout",
    "manual_auth_required",
    "not_authenticated",
    "auth_failed",
    "auth_cancelled",
    "account_identity_unavailable",
  ]);
  if (!target.agentClaimEligible) {
    return {
      label: "Approval needed",
      verified: false,
      repair: "This legacy full-access computer can run agents only for the workspace agents owner. Re-pair it as a Connector for My setup.",
    };
  }
  if (!target.approved) return { label: "Approval needed", verified: false, repair: `Approve ${target.label} in Devices before using it.` };
  if (!target.online) return { label: "Offline", verified: false, repair: `On ${target.label}, run: ${connectorRestartCommand(target.os)}` };
  if (notInstalledCodes.has(code ?? "")) {
    return { label: "Not installed", verified: false, repair: `On ${target.label}, run: ${CLI_INSTALL[provider]}` };
  }
  if (state.unsupported || unsupportedCodes.has(code ?? "") || (provider === "gemini" && state.installed && !state.signedIn)) {
    return { label: "Unsupported", verified: false, repair: "Gemini CLI cannot use this personal sign-in. Choose a Google API key instead." };
  }
  if (code === "rate_limited") {
    return {
      label: "Subscription limit reached",
      verified: false,
      repair: `${name} is still signed in on ${target.label}. Wait for the provider's usage window to reset, then Test again; reconnecting will not help.`,
    };
  }
  if (code === "account_identity_unavailable" && provider === "claude") {
    return {
      label: "Sign-in needed",
      verified: false,
      repair: `Open Claude Code once on ${target.label}, sign in so OASIS can identify the account, restart the OASIS connector, then Test again.`,
    };
  }
  if (signInCodes.has(code ?? "")) {
    return {
      label: provider === "gemini" ? "Unsupported" : "Sign-in needed",
      verified: false,
      repair: provider === "gemini"
        ? "Gemini CLI personal sign-in is not supported. Choose a Google API key instead."
        : `On ${target.label}, run: ${CLI_LOGIN[provider]}`,
    };
  }
  if (target.busy) return { label: "Busy", verified: false, repair: `${target.label} is finishing another agent run. Wait for it to finish, then Test again.` };
  if (
    !target.protocols.includes("runtime_action_v1") ||
    !target.protocols.includes("department_task_v2") ||
    !target.protocols.includes("coding_harness_task_v1")
  ) {
    return { label: "Needs test", verified: false, repair: `Update and restart the OASIS connector on ${target.label}, then Test again.` };
  }
  if (!state.installed) return { label: "Not installed", verified: false, repair: `On ${target.label}, run: ${CLI_INSTALL[provider]}` };
  if (!state.signedIn) return { label: "Sign-in needed", verified: false, repair: `On ${target.label}, run: ${CLI_LOGIN[provider]}` };
  if (!state.executionReady) return { label: "Needs test", verified: false, repair: `Test ${name} on ${target.label} before using it for agents.` };
  return { label: "Ready for agents", verified: true, repair: null };
}

/** A detected model is usable only after the selected connector has run a real probe. */
export function describeLocalModel(
  target: Pick<EngineDevice, "label" | "os" | "approved" | "online" | "busy" | "protocols" | "agentClaimEligible">,
  model: EngineDevice["localModels"][number] | undefined,
): { label: string; verified: boolean; repair: string | null } {
  if (!target.agentClaimEligible) {
    return {
      label: "Approval needed",
      verified: false,
      repair: "This legacy full-access computer can run agents only for the workspace agents owner. Re-pair it as a Connector for My setup.",
    };
  }
  if (!target.approved) return { label: "Approval needed", verified: false, repair: `Approve ${target.label} in Devices before using it.` };
  if (!target.online) return { label: "Offline", verified: false, repair: `Start Ollama or LM Studio and restart the OASIS connector on ${target.label}.` };
  if (target.busy) return { label: "Busy", verified: false, repair: `${target.label} is finishing another agent run. Wait for it to finish, then Test again.` };
  if (
    !target.protocols.includes("runtime_action_v1") ||
    !target.protocols.includes("department_task_v2") ||
    !target.protocols.includes("coding_harness_task_v1")
  ) {
    return { label: "Needs test", verified: false, repair: `Update and restart the OASIS connector on ${target.label}, then Test again.` };
  }
  if (!model) return { label: "Not installed", verified: false, repair: `Start Ollama or LM Studio on ${target.label}, install a model, then Refresh.` };
  if (model.state === "unavailable") {
    return { label: "Offline", verified: false, repair: `Start ${model.adapter === "ollama" ? "Ollama" : "LM Studio"} on ${target.label}, then Test again.` };
  }
  if (model.state !== "ready") return { label: "Needs test", verified: false, repair: `Test ${model.label} on ${target.label} before using it for agents.` };
  return { label: "Ready for agents", verified: true, repair: null };
}

export function selectionKey(selection: EngineSelection, scope: EngineScope): string {
  return `${scope}:${JSON.stringify(selection)}`;
}

export function repairForCode(
  code: string | undefined,
  deviceLabel?: string,
  provider?: CliEngine,
  deviceOS?: string | null,
): string | null {
  const where = deviceLabel ? ` on ${deviceLabel}` : " on the selected computer";
  switch (code) {
    case "pairing_required":
    case "pairing_not_found":
      return "Pair this computer in Settings > Devices, then return here and Test again.";
    case "pairing_not_approved":
      return "Approve this computer in Settings > Devices, then Test again.";
    case "agents_owner_only":
      return "This legacy full-access computer can run agents only for the workspace agents owner. Re-pair it as a Connector for My setup.";
    case "connector_offline":
    case "bridge_unavailable":
    case "runtime_unavailable":
      return `Restart the connector${where} with: ${connectorRestartCommand(deviceOS)}`;
    case "cli_not_found":
      return provider
        ? `On ${deviceLabel ?? "the selected computer"}, run: ${CLI_INSTALL[provider]}`
        : `Install the selected app${where}, then Test again.`;
    case "engine_not_found":
      return "Start Ollama or LM Studio on the selected computer, then Refresh and Test again.";
    case "cli_not_authenticated":
    case "not_authenticated":
    case "auth_failed":
    case "auth_cancelled":
    case "account_identity_unavailable":
    case "auth_process_failed":
    case "auth_start_failed":
    case "auth_timeout":
    case "cli_auth_required":
    case "manual_auth_required":
      if (provider === "gemini") return "Gemini CLI personal sign-in is not supported. Choose a Google API key instead.";
      return provider
        ? `On ${deviceLabel ?? "the selected computer"}, run: ${CLI_LOGIN[provider]}`
        : `Sign in to the selected app${where}, then Test again.`;
    case "runtime_rate_limited":
      return `The selected app is still signed in${where}, but its subscription usage limit is reached. Wait for the provider's usage window to reset, then Test again; reconnecting will not help.`;
    case "account_unsupported":
    case "unsupported_personal_sign_in":
      return "Gemini CLI cannot use this personal sign-in. Choose a Google API key instead.";
    case "runtime_engine_not_allowed":
      return "That runtime cannot perform this action. Choose a supported subscription app or API key, then Test again.";
    case "cli_empty_output":
    case "cli_nonzero_exit":
    case "runtime_action_failed":
    case "runtime_probe_failed":
    case "status_check_failed":
      return `The selected runtime could not finish the check. Restart the connector${where} with: ${connectorRestartCommand(deviceOS)}, then Test again.`;
    case "pairing_approval_lost":
      return "Approval was removed while this action was running. Approve the computer again in Settings > Devices, then Test again.";
    case "pairing_revoked":
      return "This computer pairing was revoked. Pair the computer again in Settings > Devices, then Test again.";
    case "requester_seat_inactive":
      return "Your workspace access changed while this action was running. Sign in again; if access is still blocked, ask a workspace owner or admin to restore it.";
    case "cli_timeout":
    case "runtime_job_timeout":
    case "timeout":
    case "queue_expired":
    case "lease_expired":
      return "The computer did not finish in time. Check that its connector is running, then Test again.";
    default:
      return null;
  }
}
