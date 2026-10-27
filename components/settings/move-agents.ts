/**
 * "Use for agents" on Settings > Devices (CC 2026-10-27: "whenever I'm using a
 * different computer, I select which computer I'm working on, and I can change
 * that each time"). One press moves the setup that powers the viewer's agents
 * to another of their computers: the same app (or local model) where that
 * computer has it, tested there, and saved only when the test passes. It is
 * the same Test-then-Use that Settings > AI brain runs, with no gate skipped:
 * the server still refuses a save without a passing probe of that exact setup.
 *
 * WHICH SETUP. The one that runs the viewer's agents: their own ("My setup")
 * when they chose one, otherwise the workspace default when they may change
 * it. A member who inherits a default they cannot change gets their own setup
 * on that computer, which is what "my agents run here" means for them.
 */
import { CLI_ENGINE_LABEL, type CliEngine } from "@/lib/ai/agent-engine";
import { subscriptionRolloutError } from "@/lib/ai/engine-rollout";
import {
  describeRuntime,
  pollRuntimeJob,
  queueEngineProbe,
  repairForCode,
  saveEngine,
  type EngineDevice,
  type EngineScope,
  type EngineSelection,
  type EngineState,
} from "@/components/settings/agent-engine-client";
import { runtimeStatusWords } from "@/lib/bridge-cli-status";

const APP_ORDER: CliEngine[] = ["claude", "codex", "opencode"];

/** The setup that runs the viewer's agents, and which scope it is saved under. */
export function agentsSetup(state: Pick<EngineState, "engine" | "personEngine" | "canManage">): { scope: EngineScope; selection: EngineSelection } {
  if (state.personEngine.source === "person" && state.personEngine.selection) {
    return { scope: "person", selection: state.personEngine.selection };
  }
  return state.canManage ? { scope: "workspace", selection: state.engine } : { scope: "person", selection: state.engine };
}

/** The computer the agents run on now, or null for an API key. */
export function agentsComputerId(selection: EngineSelection): string | null {
  return selection.mode === "api" ? null : selection.pairingId;
}

/** Whether this computer can be offered for the scope at all (the AI brain picker's own rule). */
export function eligibleFor(device: EngineDevice, scope: EngineScope): boolean {
  return scope === "person" ? device.ownedByViewer : device.workspaceEligible;
}

/**
 * The setup to try on `device`: the current local model's place there, else
 * the current app when the computer has it signed in, else the first other app
 * signed in there. null when none is, with the reason in plain words.
 */
export function selectionFor(
  device: EngineDevice,
  current: EngineSelection,
  oasisWorkspace: boolean,
): { ok: true; selection: EngineSelection } | { ok: false; reason: string } {
  const fallback = current.mode === "api" ? "none" : current.fallback;
  if (current.mode === "local") {
    const model = device.localModels.find((m) => m.ref === current.modelRef) ?? device.localModels.find((m) => m.state !== "unavailable");
    if (model) return { ok: true, selection: { mode: "local", pairingId: device.pairingId, modelRef: model.ref, fallback } };
  }
  const usable = (provider: CliEngine) => {
    if (subscriptionRolloutError(provider, oasisWorkspace) !== null) return false;
    const runtime = device.runtimes[provider];
    if (!runtime.installed || !runtime.signedIn || runtime.unsupported) return false;
    const words = describeRuntime(device, provider).label;
    return words === runtimeStatusWords("ready") || words === runtimeStatusWords("needs_test");
  };
  const preferred = current.mode === "subscription" ? [current.provider, ...APP_ORDER.filter((p) => p !== current.provider)] : APP_ORDER;
  const provider = preferred.find(usable);
  if (!provider) {
    return { ok: false, reason: `No AI app is signed in and ready on ${device.label}. Set one up in Settings > AI brain.` };
  }
  return { ok: true, selection: { mode: "subscription", pairingId: device.pairingId, provider, fallback } };
}

export function selectionWords(selection: EngineSelection, device: EngineDevice): string {
  return selection.mode === "subscription"
    ? `${CLI_ENGINE_LABEL[selection.provider]} on ${device.label}`
    : selection.mode === "local"
      ? `${selection.modelRef} on ${device.label}`
      : "your API key";
}

/** Test the setup on that computer, then put it in use. Never saves an untested setup. */
export async function moveAgentsToComputer(
  device: EngineDevice,
  state: EngineState,
  onProgress: (words: string) => void,
): Promise<{ ok: true; words: string } | { ok: false; words: string }> {
  const { scope, selection: current } = agentsSetup(state);
  if (!eligibleFor(device, scope)) {
    return { ok: false, words: `${device.label} cannot run ${scope === "workspace" ? "the workspace's" : "your"} agents. Choose it in Settings > AI brain to see why.` };
  }
  const picked = selectionFor(device, current, state.oasis);
  if (!picked.ok) return { ok: false, words: picked.reason };
  const words = selectionWords(picked.selection, device);
  const provider = picked.selection.mode === "subscription" ? picked.selection.provider : undefined;
  const fail = (message: string, code?: string) => {
    const repair = repairForCode(code, device.label, provider, device.os);
    return { ok: false as const, words: `${words}: ${message}${repair ? ` ${repair}` : ""} Your agents still run where they did.` };
  };
  onProgress(`Testing ${words}…`);
  const queued = await queueEngineProbe(picked.selection, scope);
  if (!queued.ok) return fail(queued.message, queued.code);
  const finished = await pollRuntimeJob(queued.jobId);
  if (!finished.ok) return fail(finished.message, finished.code);
  onProgress(`${words} passed. Putting it in use…`);
  const saved = await saveEngine(picked.selection, state.engineVersions[scope], undefined, { scope, probeJobId: queued.jobId });
  if (!saved.ok) return fail(saved.message, saved.code);
  return { ok: true, words: `Your ${scope === "workspace" ? "workspace's " : ""}agents now run on ${words}.` };
}
