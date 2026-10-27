"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2,
  CircleAlert,
  Cloud,
  Copy,
  Cpu,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { CLI_ENGINE_LABEL, type ApiEngineProvider, type CliEngine } from "@/lib/ai/agent-engine";
import { PROVIDER_LABEL } from "@/lib/providers";
import {
  describeLocalModel,
  describeRuntime,
  connectorRestartCommand,
  draftForEngineMode,
  engineDevicesForScope,
  inheritWorkspaceEngine,
  pollRuntimeJob,
  queueEngineProbe,
  readEngine,
  repairForCode,
  runtimeStatusLabel,
  saveEngine,
  selectionKey,
  type EngineDevice,
  type EngineScope,
  type EngineSelection,
  type EngineState,
  type RuntimeJob,
} from "@/components/settings/agent-engine-client";
import { startCliSignIn } from "@/components/settings/LocalCliProvidersCard";
import {
  OPEN_AI_PROVIDER_ACCOUNT_EVENT,
  OASIS_PROVIDER_KEY_STAGED_EVENT,
  type ProviderAccountOpenRequest,
  type ProviderKeyStagedDetail,
} from "@/components/settings/ProviderAccountsCard";
import { CODEX_OASIS_ROLLOUT_MESSAGE, subscriptionRolloutError } from "@/lib/ai/engine-rollout";
import { runtimeStatusWords } from "@/lib/bridge-cli-status";
import { presenceWords } from "@/lib/devices/presence";
import { AgentEngineScopeProvider } from "@/components/settings/agent-engine-scope-context";

/** How often an open AI brain page re-reads its computers. */
const ENGINE_AUTO_REFRESH_MS = 30_000;
const CLI_PROVIDERS: CliEngine[] = ["claude", "codex", "opencode"];
const API_PROVIDERS: ApiEngineProvider[] = ["anthropic", "openai", "google", "openrouter"];
const INSTALL_COMMAND: Record<CliEngine, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
};
const LOGIN_COMMAND: Record<CliEngine, string> = {
  claude: "claude\n/login",
  codex: "codex login",
  opencode: "opencode auth login",
};

type Notice = { tone: "ok" | "error" | "info"; text: string; repair?: string | null } | null;
type Activity = "reading" | "testing" | "saving" | "connecting" | "inheriting" | null;

function engineTitle(selection: EngineSelection, devices: EngineDevice[] = []): string {
  const computer = selection.mode === "api" ? null : devices.find((device) => device.pairingId === selection.pairingId)?.label;
  if (selection.mode === "subscription") return `${CLI_ENGINE_LABEL[selection.provider]} on ${computer ?? "a paired computer"}`;
  if (selection.mode === "local") return `${selection.modelRef} on ${computer ?? "a paired computer"}`;
  return `${PROVIDER_LABEL[selection.provider]} API key`;
}

function selectedPairing(selection: EngineSelection): string | null {
  return selection.mode === "api" ? null : selection.pairingId;
}

function deviceFor(devices: EngineDevice[], selection: EngineSelection): EngineDevice | null {
  const pairingId = selectedPairing(selection);
  return pairingId ? devices.find((device) => device.pairingId === pairingId) ?? null : null;
}

function versionForScope(state: EngineState, scope: EngineScope): string | null {
  return state.engineVersions[scope];
}

function commandFor(device: EngineDevice, provider: CliEngine): string | null {
  const runtime = device.runtimes[provider];
  if (!device.online) return connectorRestartCommand(device.os);
  if (!runtime.installed) return INSTALL_COMMAND[provider];
  if (!runtime.signedIn) return LOGIN_COMMAND[provider];
  return null;
}

function jobSentence(job: RuntimeJob): string {
  if (job.status === "queued") return "Queued on the selected computer.";
  if (job.status === "claimed") return "The selected computer claimed the job.";
  if (job.status === "running") return "The selected computer is running the check.";
  if (job.status === "waiting_user") return job.result?.instructions ?? job.message ?? "Finish the sign-in on the selected computer.";
  if (job.status === "done") return "The selected computer finished successfully.";
  return job.message ?? "The selected computer could not finish the job.";
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function AccountSection({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="space-y-2 border-t border-hairline pt-4" data-testid="engine-ai-account">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        API provider accounts
      </div>
      <p className="text-xs leading-relaxed text-fg-muted">Connect, replace, test or remove provider keys here.</p>
      {children}
    </div>
  );
}

export function AgentEnginePanel({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<EngineState | null>(null);
  const [draft, setDraftState] = useState<EngineSelection | null>(null);
  const [scope, setScopeState] = useState<EngineScope>("person");
  const [readError, setReadError] = useState<string | null>(null);
  // A refresh that failed while the panel already shows a setup. CC
  // (2026-10-27): the computer picker "sometimes disappears". A failed
  // refresh used to replace the whole panel with an error box; now the last
  // good reading stays on screen with this line above it, and the next
  // refresh clears it.
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [activity, setActivityState] = useState<Activity>("reading");
  const activityRef = useRef<Activity>("reading");
  const hasStateRef = useRef(false);
  const setActivity = (next: Activity) => {
    activityRef.current = next;
    setActivityState(next);
  };
  const [notice, setNotice] = useState<Notice>(null);
  const [job, setJob] = useState<RuntimeJob | null>(null);
  const [probeReceipt, setProbeReceipt] = useState<{ key: string; jobId: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [stagedKeyReceipts, setStagedKeyReceipts] = useState<Partial<Record<ApiEngineProvider, string>>>({});
  const stop = useRef<AbortController | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<EngineScope>("person");
  // Has the viewer picked a tab? Until they do, a manager opens on "Workspace
  // default": the account every workspace tool runs on (lib/ai/
  // workspace-account.ts). Opening managers on "My setup" saved CC's
  // Anthropic key as personal on 2026-10-14, so Write my page kept running on
  // the workspace's old Gemini key until its quota ran out (2026-10-16).
  const scopeChosen = useRef(false);
  const draftRef = useRef<EngineSelection | null>(null);
  // The runtime choices ("Subscription app", "Pure local", "API key"): where
  // "Choose your own" takes a person who inherits the workspace default.
  const choicesRef = useRef<HTMLDivElement | null>(null);

  // Every read is numbered. A background re-read applies only if no other read
  // started after it and no Test, Save or sign-in started meanwhile.
  const readSeq = useRef(0);

  /**
   * The 30 s background re-read: each computer's presence and app lines only.
   * It never touches the draft, the saved choice, its version or the staged
   * key receipts (they are what a Save is checked against, Codex review of
   * #758), and never the activity state of a Test, Save or sign-in.
   */
  async function refreshComputers() {
    const seq = ++readSeq.current;
    const result = await readEngine();
    if (seq !== readSeq.current || activityRef.current !== null) return;
    if (!result.ok) {
      setRefreshWarning(`${result.message} Showing the last reading.`);
      return;
    }
    setRefreshWarning(null);
    setState((current) => (current ? { ...current, devices: result.state.devices, bridgeReachable: result.state.bridgeReachable } : current));
  }

  async function load(options: { keepDraft?: boolean; show?: boolean } = {}) {
    ++readSeq.current;
    if (!options.keepDraft || options.show) setActivity("reading");
    const result = await readEngine();
    if (!result.ok) {
      if (hasStateRef.current) setRefreshWarning(`${result.message} Showing the last reading.`);
      else setReadError(result.message);
      setActivity(null);
      return;
    }
    setReadError(null);
    setRefreshWarning(null);
    hasStateRef.current = true;
    setState(result.state);
    setStagedKeyReceipts(result.state.savedKeyReceipts);
    if (!options.keepDraft || !draftRef.current) {
      const wanted: EngineScope = scopeChosen.current ? scopeRef.current : "workspace";
      const nextScope: EngineScope = wanted === "workspace" && result.state.canManage ? "workspace" : "person";
      const next =
        nextScope === "workspace"
          ? result.state.engine
          : result.state.personEngine.source === "person" && result.state.personEngine.selection
            ? result.state.personEngine.selection
            : result.state.engine;
      scopeRef.current = nextScope;
      draftRef.current = next;
      setScopeState(nextScope);
      setDraftState(next);
    }
    setActivity(null);
  }

  useEffect(() => {
    void load();
    const refreshAccount = () => void load({ keepDraft: true });
    const rememberStagedKey = (event: Event) => {
      const detail = (event as CustomEvent<ProviderKeyStagedDetail>).detail;
      if (!detail || !API_PROVIDERS.includes(detail.provider as ApiEngineProvider) || !detail.receipt) return;
      setStagedKeyReceipts((current) => ({ ...current, [detail.provider]: detail.receipt }));
    };
    window.addEventListener("oasis:agent-configs-changed", refreshAccount);
    window.addEventListener(OASIS_PROVIDER_KEY_STAGED_EVENT, rememberStagedKey);
    // Keep each computer's online state and app lines current while the page
    // is open, without touching what the viewer is editing: only when no Test,
    // Save or sign-in is running and the tab is in view.
    const timer = setInterval(() => {
      if (hasStateRef.current && activityRef.current === null && document.visibilityState === "visible") void refreshComputers();
    }, ENGINE_AUTO_REFRESH_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener("oasis:agent-configs-changed", refreshAccount);
      window.removeEventListener(OASIS_PROVIDER_KEY_STAGED_EVENT, rememberStagedKey);
      stop.current?.abort();
    };
    // The initial server truth is intentionally read once; refresh actions call load explicitly.
  }, []);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  if (readError) {
    return (
      <div className="space-y-4" data-testid="agent-engine">
        <div role="alert" className="rounded-lg border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-fg">
          {readError}
          <button type="button" onClick={() => void load()} className="ml-2 font-semibold text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            Retry
          </button>
        </div>
        <AgentEngineScopeProvider scope={scope}>
          <AccountSection>{children}</AccountSection>
        </AgentEngineScopeProvider>
      </div>
    );
  }

  if (!state || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading your AI setup…
      </div>
    );
  }

  // Stable non-null snapshots for async callbacks created by this render.
  const loadedState = state;
  const draftSelection = draft;
  const eligibleDevices = engineDevicesForScope(state.devices, scope);
  // The "Installed apps" list follows the SAME scope as the computer picker. It
  // used to show every pairing in the workspace to any manager, whatever tab was
  // selected, so a teammate's computer (with its "Needs test" runtimes, which
  // you cannot act on) sat on CC's own "My setup" page. "My setup" lists only
  // your computers; "Workspace default" lists the workspace-eligible ones, each
  // already labelled with its owner.
  const inventoryDevices =
    scope === "person"
      ? state.devices.filter((device) => device.ownedByViewer)
      : engineDevicesForScope(state.devices, "workspace");
  const current =
    scope === "workspace"
      ? state.engine
      : state.personEngine.source === "person" && state.personEngine.selection
        ? state.personEngine.selection
        : state.engine;
  // On "My setup" with no engine of your own: what is in use is the workspace's,
  // and the line says so instead of "In use for you: <the workspace's key>".
  const inheritsWorkspaceDefault =
    scope === "person" && !(state.personEngine.source === "person" && state.personEngine.selection);
  const legacyNeedsComputer = current.mode !== "api" && !current.pairingId;
  const selectedDevice = deviceFor(state.devices, draft);
  const selectedCli = draft.mode === "subscription" ? draft.provider : undefined;
  const selectedLocalModel =
    draft.mode === "local" ? selectedDevice?.localModels.find((model) => model.ref === draft.modelRef) : undefined;
  const draftKey = selectionKey(draft, scope);
  const apiConnected =
    draft.mode === "api" &&
    (scope === "workspace"
      ? state.savedProviders.includes(draft.provider) || state.account?.provider === draft.provider
      : state.account?.provider === draft.provider);
  const apiProviderOptions = scope === "workspace" && state.canManage
    ? API_PROVIDERS
    : state.account
      ? [state.account.provider]
      : [];
  const tested = draft.mode === "api" ? apiConnected : probeReceipt?.key === draftKey;
  const rolloutBlocked = draft.mode === "subscription" && subscriptionRolloutError(draft.provider, state.oasis) !== null;
  const canEdit = scope === "person" || state.canManage;
  const jobAuthUrl = safeHttpUrl(job?.result?.authUrl);

  function setDraft(next: EngineSelection) {
    draftRef.current = next;
    setDraftState(next);
    setProbeReceipt(null);
    setJob(null);
    setNotice(null);
  }

  function openProviderAccount(provider: ApiEngineProvider) {
    if (scope !== "workspace" || !loadedState.canManage) return;
    const detail: ProviderAccountOpenRequest = {
      provider,
      scope: "tenant",
      stageOnly: true,
      lockScope: true,
    };
    window.dispatchEvent(new CustomEvent(OPEN_AI_PROVIDER_ACCOUNT_EVENT, { detail }));
  }

  function changeScope(next: EngineScope) {
    if (next === "workspace" && !loadedState.canManage) return;
    scopeChosen.current = true;
    scopeRef.current = next;
    setScopeState(next);
    setDraft(
      next === "workspace"
        ? loadedState.engine
        : loadedState.personEngine.source === "person" && loadedState.personEngine.selection
          ? loadedState.personEngine.selection
          : loadedState.engine,
    );
  }

  /**
   * "Choose your own" (CC 2026-10-16): a person who inherits the workspace
   * default was told to "choose one below" with nothing to press. The choice
   * IS the runtime radios below (the draft already starts from the setup in
   * use), so this brings them into view and puts the keyboard on the selected
   * one, ready to move between the three with the arrow keys.
   */
  function chooseOwnEngine() {
    const group = choicesRef.current;
    if (!group) return;
    group.scrollIntoView({ behavior: "smooth", block: "center" });
    const radio =
      group.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      group.querySelector<HTMLInputElement>('input[type="radio"]');
    radio?.focus({ preventScroll: true });
  }

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopyFeedback(`Copied: ${command}`);
    } catch {
      setCopyFeedback(`Copy failed. Select and copy: ${command}`);
    }
  }

  async function testSelection() {
    if (draftSelection.mode === "api") return;
    const controller = new AbortController();
    stop.current = controller;
    setActivity("testing");
    setNotice(null);
    setJob(null);
    setProbeReceipt(null);
    const queued = await queueEngineProbe(draftSelection, scope, undefined, { signal: controller.signal });
    if (!queued.ok) {
      setActivity(null);
      setNotice({ tone: "error", text: queued.message, repair: repairForCode(queued.code, selectedDevice?.label, selectedCli, selectedDevice?.os) });
      return;
    }
    const finished = await pollRuntimeJob(queued.jobId, undefined, {
      signal: controller.signal,
      onUpdate: setJob,
    });
    setActivity(null);
    if (!finished.ok) {
      setNotice({ tone: "error", text: finished.message, repair: repairForCode(finished.code, selectedDevice?.label, selectedCli, selectedDevice?.os) });
      return;
    }
    setProbeReceipt({ key: draftKey, jobId: queued.jobId });
    const latency = finished.job.result?.latencyMs;
    const reply = finished.job.result?.reply;
    setNotice({
      tone: "ok",
      text: `${engineTitle(draftSelection, loadedState.devices)} passed${typeof latency === "number" ? ` in ${(latency / 1000).toFixed(1)} s` : ""}.${reply ? ` “${reply.slice(0, 140)}”` : ""}`,
    });
  }

  async function saveSelection() {
    if (draftSelection.mode !== "api" && (!probeReceipt || probeReceipt.key !== draftKey)) return;
    const controller = new AbortController();
    stop.current = controller;
    setActivity("saving");
    setNotice(null);
    const result = await saveEngine(draftSelection, versionForScope(loadedState, scope), undefined, {
      scope,
      ...(draftSelection.mode === "api" && scope === "workspace" && stagedKeyReceipts[draftSelection.provider]
        ? { savedKeyReceipt: stagedKeyReceipts[draftSelection.provider] }
        : {}),
      ...(probeReceipt?.key === draftKey ? { probeJobId: probeReceipt.jobId } : {}),
      signal: controller.signal,
    });
    setActivity(null);
    if (!result.ok) {
      setNotice({
        tone: "error",
        text: result.message,
        repair: repairForCode(result.code, selectedDevice?.label, selectedCli, selectedDevice?.os),
      });
      await load({ keepDraft: true });
      return;
    }
    setNotice({ tone: "ok", text: `${engineTitle(draftSelection, loadedState.devices)} is now in use for ${scope === "workspace" ? "the workspace default" : "your setup"}.` });
    await load();
    router.refresh();
  }

  async function applyWorkspaceDefault() {
    setActivity("inheriting");
    setNotice(null);
    const result = await inheritWorkspaceEngine(versionForScope(loadedState, "person"));
    setActivity(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.message, repair: repairForCode(result.code) });
      return;
    }
    setNotice({ tone: "ok", text: "Your agents now inherit the workspace default." });
    setProbeReceipt(null);
    await load();
    router.refresh();
  }

  async function connect(provider: CliEngine) {
    if (!selectedDevice || !selectedDevice.ownedByViewer) return;
    const controller = new AbortController();
    stop.current = controller;
    setActivity("connecting");
    setNotice(null);
    setCopyFeedback(null);
    const started = await startCliSignIn(provider, selectedDevice.pairingId);
    if (!started.ok) {
      setActivity(null);
      setNotice({ tone: "error", text: started.text, repair: started.command ? `Run on ${selectedDevice.label}: ${started.command}` : null });
      return;
    }
    if (!started.jobId) {
      setActivity(null);
      setNotice({ tone: "info", text: started.text });
      await load({ keepDraft: true });
      return;
    }
    setNotice({
      tone: "info",
      text: started.text,
      repair: started.command ? `On ${selectedDevice.label}, run: ${started.command}` : null,
    });
    const finished = await pollRuntimeJob(started.jobId, undefined, {
      signal: controller.signal,
      onUpdate: setJob,
    });
    setActivity(null);
    if (!finished.ok) {
      setNotice({ tone: "error", text: finished.message, repair: repairForCode(finished.code, selectedDevice.label, provider, selectedDevice.os) });
      return;
    }
    setNotice({ tone: "info", text: `${CLI_ENGINE_LABEL[provider]} finished sign-in on ${selectedDevice.label}. Verifying a real agent reply now…` });
    await load({ keepDraft: true });
    await testSelection();
  }

  const modeOption = (mode: EngineSelection["mode"], icon: React.ReactNode, title: string, description: string) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${
        draft.mode === mode ? "border-accent/60 bg-accent-soft" : "border-hairline bg-bg-panel hover:border-bg-border-strong"
      } ${!canEdit ? "cursor-default opacity-70" : ""}`}
    >
      <input
        type="radio"
        name="agent-engine"
        value={mode === "subscription" ? "cli" : mode === "local" ? "local" : "api"}
        checked={draft.mode === mode}
        disabled={!canEdit}
        onChange={() => setDraft(draftForEngineMode(mode, state, scope))}
        className="mt-1"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          {icon}
          {title}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-fg-muted">{description}</span>
      </span>
    </label>
  );

  const devicePicker = draft.mode !== "api" && (
    <div className="space-y-1.5">
      <label htmlFor="engine-device" className="text-xs font-semibold text-fg">
        Computer
      </label>
      {eligibleDevices.length ? (
        <select
          id="engine-device"
          aria-label="Computer for this AI setup"
          value={draft.pairingId}
          disabled={!canEdit}
          onChange={(event) => {
            const pairingId = event.target.value;
            if (draft.mode === "subscription") setDraft({ ...draft, pairingId });
            else {
              const target = state.devices.find((item) => item.pairingId === pairingId);
              setDraft({ ...draft, pairingId, modelRef: target?.localModels[0]?.ref ?? "" });
            }
          }}
          className="select w-full !py-2 !text-sm"
        >
          {!eligibleDevices.some((device) => device.pairingId === draft.pairingId) && <option value="">Choose a computer</option>}
          {eligibleDevices.map((device) => (
            <option key={device.pairingId} value={device.pairingId}>
              {device.label}{device.ownerName ? ` · ${device.ownerName}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="rounded-lg border border-status-warm/40 bg-status-warm/10 p-3 text-xs text-fg-muted">
          No approved computer is available for this setup. <Link href="/settings/devices" className="font-semibold text-accent underline underline-offset-2">Pair or approve a computer</Link>.
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4" data-testid="agent-engine">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-fg">
            In use for {scope === "workspace" ? "the workspace default" : "you"}: <span className="font-semibold">{engineTitle(current, state.devices)}</span>
            {inheritsWorkspaceDefault && (
              <span className="text-fg-muted" data-testid="engine-inherited"> (the workspace default)</span>
            )}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {inheritsWorkspaceDefault
              ? "You have not chosen your own, so you use the workspace default. Choosing your own changes only your setup."
              : "Choose where the model runs, verify that exact connection, then put it in use."}
          </p>
          {inheritsWorkspaceDefault && (
            <button
              type="button"
              data-testid="engine-choose-own"
              onClick={chooseOwnEngine}
              className="mt-2 rounded-md border border-hairline px-3 py-1.5 text-xs font-semibold text-fg hover:border-bg-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Choose your own
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load({ keepDraft: true, show: true })}
          disabled={activity !== null}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${activity === "reading" ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {refreshWarning && (
        <p role="status" data-testid="engine-refresh-warning" className="rounded-lg border border-status-warm/40 bg-status-warm/10 px-3 py-2 text-xs text-fg-muted">
          {refreshWarning}
        </p>
      )}

      {state.canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="AI setup scope" className="inline-flex rounded-lg border border-hairline bg-bg-deep/50 p-1">
            {(["person", "workspace"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={scope === item}
                onClick={() => changeScope(item)}
                disabled={activity !== null}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  scope === item ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"
                } disabled:opacity-50`}
              >
                {item === "person" ? "My setup" : "Workspace default"}
              </button>
            ))}
          </div>
          {scope === "person" && state.personEngine.source === "person" && (
            <button
              type="button"
              onClick={() => void applyWorkspaceDefault()}
              disabled={activity !== null}
              className="text-xs font-semibold text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              Use workspace default
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-bg-panel p-3">
          <div>
            <div className="text-sm font-semibold text-fg">My setup</div>
            <div className="text-xs text-fg-muted">
              {state.personEngine.source === "workspace" ? "You currently inherit the workspace default." : "Your personal setup overrides the workspace default."}
            </div>
          </div>
          {state.personEngine.source === "person" && (
            <button
              type="button"
              onClick={() => void applyWorkspaceDefault()}
              disabled={activity !== null}
              className="rounded-md border border-hairline px-3 py-1.5 text-xs font-semibold text-fg hover:border-bg-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              Use workspace default
            </button>
          )}
        </div>
      )}

      {legacyNeedsComputer && (
        <div className="rounded-lg border border-status-warm/40 bg-status-warm/10 p-3 text-xs leading-relaxed text-fg" role="status">
          Choose a computer to finish upgrading this saved setup. Nothing will run or spend API credits until that exact computer passes Test.
        </div>
      )}

      <div ref={choicesRef} className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="AI runtime type">
        {modeOption("subscription", <Cpu className="h-4 w-4" aria-hidden="true" />, "Subscription app", "Use an AI app signed in on a paired computer. No API credits.")}
        {modeOption("local", <HardDrive className="h-4 w-4" aria-hidden="true" />, "Pure local", "Use an Ollama or LM Studio model detected on a paired computer.")}
        {modeOption("api", <Cloud className="h-4 w-4" aria-hidden="true" />, "API key", "Use Anthropic, OpenAI, Google or OpenRouter with usage-based billing.")}
      </div>

      {draft.mode === "subscription" && (
        <div className="space-y-3 rounded-lg border border-hairline bg-bg-panel p-3">
          {devicePicker}
          <div className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="Subscription app">
            {CLI_PROVIDERS.map((provider) => {
              const runtime = selectedDevice?.runtimes[provider];
              const rolloutRestricted = subscriptionRolloutError(provider, state.oasis) !== null;
              const status = rolloutRestricted
                ? { label: runtimeStatusWords("unsupported"), verified: false, repair: CODEX_OASIS_ROLLOUT_MESSAGE }
                : selectedDevice
                  ? describeRuntime(selectedDevice, provider)
                  : null;
              const unsupported = status?.label === runtimeStatusWords("unsupported");
              const subscriptionLimited = runtime?.code === "rate_limited";
              const selected = draft.provider === provider;
              return (
                <div key={provider} className={`rounded-lg border p-3 ${selected ? "border-accent/60 bg-accent-soft" : "border-hairline bg-bg-deep/40"}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!canEdit || !selectedDevice || unsupported}
                    onClick={() => setDraft({ ...draft, provider })}
                    className="w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="block text-sm font-semibold text-fg">{CLI_ENGINE_LABEL[provider]}</span>
                    <span className="mt-1 block text-[11px] text-fg-muted">{status?.label ?? "Choose a computer"}</span>
                    {runtime?.version && <span className="mt-1 block truncate font-mono text-[10px] text-fg-dim">{runtime.version}</span>}
                  </button>
                  {(selected || unsupported) && status?.repair && <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">{status.repair}</p>}
                  {selected && selectedDevice && !unsupported && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {provider === "opencode" ? (
                        // OpenCode signs in to a model provider in a terminal
                        // on that computer; there is no browser sign-in to start.
                        <span className="text-[11px] text-fg-muted">
                          {runtime?.signedIn
                            ? "Signed in to a provider on that computer. Test it here."
                            : `Sign in on ${selectedDevice.label} in a terminal: opencode auth login, and choose a provider (Kimi K2 is under Moonshot AI). Then Test.`}
                        </span>
                      ) : subscriptionLimited ? (
                        <span className="text-[11px] text-fg-muted">Still signed in. Wait for the subscription usage window to reset, then Test again; no reconnect is needed.</span>
                      ) : selectedDevice.ownedByViewer ? (
                        <button
                          type="button"
                          onClick={() => void connect(provider)}
                          disabled={!canEdit || activity !== null || rolloutRestricted}
                          className="rounded-md border border-hairline px-2.5 py-1.5 text-[11px] font-semibold text-fg hover:border-bg-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                        >
                          {runtime?.signedIn ? "Reconnect" : "Connect"}
                        </button>
                      ) : (
                        <span className="text-[11px] text-fg-muted">
                          {selectedDevice.ownerName ?? "The computer owner"} must connect this app on that computer.
                        </span>
                      )}
                      {commandFor(selectedDevice, provider) && (
                        <button
                          type="button"
                          aria-label={`Copy repair command for ${CLI_ENGINE_LABEL[provider]}`}
                          onClick={() => void copyCommand(commandFor(selectedDevice, provider)!)}
                          className="inline-flex items-center gap-1 text-[11px] text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          <Copy className="h-3 w-3" aria-hidden="true" /> Copy command
                        </button>
                      )}
                    </div>
                  )}
                  {unsupported && (
                    <button
                      type="button"
                      onClick={() => setDraft({ mode: "api", provider: "google" })}
                      className="mt-2 text-[11px] font-semibold text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      Use Google API key
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {draft.mode === "local" && (
        <div className="space-y-3 rounded-lg border border-hairline bg-bg-panel p-3">
          {devicePicker}
          {selectedDevice?.localModels.length ? (
            <div className="space-y-1.5">
              <label htmlFor="engine-local-model" className="text-xs font-semibold text-fg">Detected model</label>
              <select
                id="engine-local-model"
                value={draft.modelRef}
                disabled={!canEdit}
                onChange={(event) => setDraft({ ...draft, modelRef: event.target.value })}
                className="select w-full !py-2 !text-sm"
              >
                {selectedDevice.localModels.map((model) => (
                  <option key={model.ref} value={model.ref}>{model.label} · {model.adapter === "ollama" ? "Ollama" : "LM Studio"}</option>
                ))}
              </select>
              <p className="text-[11px] text-fg-muted">Detected on {selectedDevice.label}. Test verifies that the model can complete an agent reply.</p>
              {selectedLocalModel && (() => {
                const status = describeLocalModel(selectedDevice, selectedLocalModel);
                return (
                  <div className="text-[11px] leading-relaxed text-fg-muted" role="status">
                    <span className="font-semibold text-fg">{status.label}.</span>{status.repair ? ` ${status.repair}` : ""}
                  </div>
                );
              })()}
            </div>
          ) : (
            <div className="rounded-lg border border-status-warm/40 bg-status-warm/10 p-3 text-xs text-fg-muted">
              No local model was reported on this computer. Start Ollama or LM Studio there, then Refresh.
            </div>
          )}
        </div>
      )}

      {draft.mode === "api" && (
        <div className="space-y-3 rounded-lg border border-hairline bg-bg-panel p-3">
          <label htmlFor="engine-api-provider" className="text-xs font-semibold text-fg">Provider</label>
          <select
            id="engine-api-provider"
            value={apiProviderOptions.includes(draft.provider) ? draft.provider : ""}
            disabled={!canEdit}
            onChange={(event) => setDraft({ mode: "api", provider: event.target.value as ApiEngineProvider })}
            className="select w-full !py-2 !text-sm"
          >
            {!apiProviderOptions.includes(draft.provider) && (
              <option value="" disabled>
                {apiProviderOptions.length ? "Choose the active account" : "Connect an API provider below"}
              </option>
            )}
            {apiProviderOptions.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABEL[provider]}
                {state.account?.provider === provider
                  ? " · active key"
                  : state.savedProviders.includes(provider)
                    ? " · saved key"
                    : " · connect key"}
              </option>
            ))}
          </select>
          {scope === "workspace" && state.canManage ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
              <span>
                {apiConnected
                  ? state.account?.provider === draft.provider
                    ? "A workspace key is saved for this provider. Test or replace it at any time."
                    : "A saved key is ready to be tested before OASIS switches the workspace account."
                  : "No workspace key is saved for this provider yet."}
              </span>
              <button
                type="button"
                onClick={() => openProviderAccount(draft.provider)}
                className="font-semibold text-accent underline underline-offset-2 hover:text-accent-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {apiConnected ? `Replace ${PROVIDER_LABEL[draft.provider]} key` : `Connect ${PROVIDER_LABEL[draft.provider]} key`}
              </button>
            </div>
          ) : state.canManage ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
              <span>My setup uses the workspace API account; changing its provider affects the whole workspace.</span>
              <button
                type="button"
                onClick={() => changeScope("workspace")}
                className="font-semibold text-accent underline underline-offset-2 hover:text-accent-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Manage under Workspace default
              </button>
            </div>
          ) : (
            <p className="text-[11px] text-fg-muted">
              The workspace owner manages this API account. You can use the active provider or choose a computer-backed setup.
            </p>
          )}
        </div>
      )}

      {draft.mode !== "api" && (
        <label className="flex items-start gap-2 rounded-lg border border-hairline bg-bg-panel p-3">
          <input
            type="checkbox"
            checked={draft.fallback === "workspace_api"}
            disabled={!canEdit || !state.account}
            onChange={(event) => setDraft({ ...draft, fallback: event.target.checked ? "workspace_api" : "none" })}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-semibold text-fg">API fallback is {draft.fallback === "workspace_api" ? "on" : "off"}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
              Off by default. When enabled, the workspace API key may answer only if this exact computer cannot.
              {!state.account ? " Connect an API key below before enabling it." : ""}
            </span>
          </span>
        </label>
      )}

      {job && activity !== null && (
        <div className="rounded-lg border border-hairline bg-bg-panel p-3" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {jobSentence(job)}
          </div>
          {jobAuthUrl && (
            <a href={jobAuthUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs font-semibold text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              Open sign-in
            </a>
          )}
          <div className="mt-1 font-mono text-[10px] text-fg-dim">Job {job.id} · {job.status}</div>
        </div>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
          className={`rounded-lg border p-3 text-sm focus:outline-none ${
            notice.tone === "ok"
              ? "border-status-engaged/40 bg-status-engaged/10 text-fg"
              : notice.tone === "error"
                ? "border-status-warm/40 bg-status-warm/10 text-fg"
                : "border-hairline bg-bg-panel text-fg"
          }`}
        >
          <div className="flex items-start gap-2">
            {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-engaged" aria-hidden="true" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warm" aria-hidden="true" />}
            <div>
              <div>{notice.text}</div>
              {notice.repair && <div className="mt-1 text-xs text-fg-muted">{notice.repair}</div>}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {draft.mode !== "api" && (
          <button
            type="button"
            onClick={() => void testSelection()}
            disabled={!canEdit || activity !== null || !selectedDevice || !selectedDevice.agentClaimEligible || rolloutBlocked || (draft.mode === "local" && !draft.modelRef)}
            className="rounded-md border border-hairline px-3 py-2 text-xs font-semibold text-fg hover:border-bg-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activity === "testing" ? "Testing…" : "Test"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveSelection()}
          disabled={!canEdit || activity !== null || !tested || rolloutBlocked}
          className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-bg-deep hover:bg-accent-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {activity === "saving" ? "Saving…" : "Use this for my agents"}
        </button>
        {activity && activity !== "reading" && (
          <button
            type="button"
            data-testid="engine-cancel"
            onClick={() => stop.current?.abort()}
            className="px-2 py-2 text-xs font-semibold text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Stop waiting
          </button>
        )}
        {!tested && (
          <span className="text-[11px] text-fg-dim">
            {draft.mode === "api" ? "Connect and test this provider in its account card below before Use is enabled." : "Use stays locked until this exact setup passes Test."}
          </span>
        )}
      </div>

      {copyFeedback && (
        <div role="status" aria-live="polite" className="rounded-md border border-hairline bg-bg-panel px-3 py-2 font-mono text-[11px] text-fg-muted">
          {copyFeedback}
        </div>
      )}

      <section className="space-y-3 border-t border-hairline pt-4" aria-labelledby="engine-inventory-title">
        <div>
          <h3 id="engine-inventory-title" className="text-sm font-semibold text-fg">Installed apps and local models</h3>
          <p className="mt-1 text-xs text-fg-muted">What each paired computer last reported. Installed or signed in is not agent-ready until a real Test passes.</p>
        </div>
        {inventoryDevices.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {inventoryDevices.map((device) => (
              <div key={device.pairingId} className="rounded-lg border border-hairline bg-bg-panel p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-fg" title={device.label}>{device.label}</div>
                    {device.ownerName && <div className="text-[11px] text-fg-dim">{device.ownerName}</div>}
                  </div>
                  {/* The computer's own state in the words Devices prints for it (presenceWords, CC 2026-10-16).
                      Online and busy by the same order describeRuntime reads them in. */}
                  <span data-testid="engine-device-presence" className={`text-[11px] font-semibold ${device.online ? "text-status-engaged" : "text-status-warm"}`}>
                    {presenceWords(device.online ? (device.busy ? "busy" : "online") : "offline", device.lastSeenAt)}
                  </span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {CLI_PROVIDERS.map((provider) => {
                    const runtime = device.runtimes[provider];
                    return (
                      <div key={provider} className="rounded-md border border-hairline bg-bg-deep/40 px-2.5 py-2">
                        <div className="text-xs font-semibold text-fg">{CLI_ENGINE_LABEL[provider]}</div>
                        <div className="mt-0.5 text-[11px] text-fg-muted" data-testid="engine-inventory-status">
                          {/* The same words Devices shows for this app on this computer (CC 2026-10-16). */}
                          {runtimeStatusLabel(device, provider, state.oasis)}
                        </div>
                        {runtime.version && <div className="mt-0.5 truncate font-mono text-[10px] text-fg-dim">{runtime.version}</div>}
                      </div>
                    );
                  })}
                </div>
                {device.localModels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {device.localModels.map((model) => (
                      <span key={model.ref} className="rounded-md border border-hairline px-2 py-1 text-[11px] text-fg-muted">
                        {model.label} · {describeLocalModel(device, model).label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-hairline bg-bg-panel p-3 text-xs text-fg-muted">
            No paired computer has reported its installed runtimes yet. <Link href="/settings/devices" className="font-semibold text-accent underline underline-offset-2">Add a computer</Link>.
          </div>
        )}
      </section>

      <AgentEngineScopeProvider key={scope} scope={scope}>
        <AccountSection>{children}</AccountSection>
      </AgentEngineScopeProvider>
    </div>
  );
}
