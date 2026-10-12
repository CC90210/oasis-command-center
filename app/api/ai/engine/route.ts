/**
 * Canonical AI Brain engine API.
 *
 * GET exposes the workspace/default choice, this person's optional override,
 * and truthful per-pairing runtime evidence. POST queues one restricted probe
 * on the exact selected computer. PUT accepts that selection only after a
 * fresh matching probe and a compare-and-swap on the engine row version.
 */
import { NextRequest, NextResponse } from "next/server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  connectWorkspaceAccountAndEngineInOneStep,
  hasUsableKey,
  readAccountStamp,
  readWorkspaceAiAccount,
} from "@/lib/ai/workspace-account";
import { departmentBrain } from "@/lib/ai/department-brain";
import {
  clearPersonEngineIfCurrent,
  isOasisWorkspace,
  readAgentEngine,
  readAgentEngineVersion,
  readEffectiveAgentEngineWithProof,
  readPersonAgentEngine,
  readPersonAgentEngineVersion,
  readSavedProviders,
  readSavedKey,
  keepSavedKey,
  saveAgentEngineIfCurrent,
  savePersonAgentEngineIfCurrent,
  savedRuntimeProbeProofReady,
  type SavedRuntimeProbeProof,
  type SavedRuntimeProbeProofInput,
} from "@/lib/ai/agent-engine-store";
import {
  choiceFromSelection,
  isApiEngineProvider,
  selectionFromRequest,
  selectionFromChoice,
  type AgentEngineChoice,
  type ApiEngineProvider,
  type EngineSelection,
} from "@/lib/ai/agent-engine";
import {
  enqueueRuntimeJob,
  isFreshRuntimeProbeReceipt,
  readLatestRuntimeProbeReceipts,
  readRuntimeJobForOwner,
  runtimeProbeReceiptKey,
  type RuntimeEngine,
  type RuntimeProbeReceipt,
  RUNTIME_PROBE_FRESH_MS,
} from "@/lib/bridge/runtime-jobs";
import { readAgentsOwner } from "@/lib/agents-owner";
import { CLI_INVENTORY_SERVICE, normalizeCliMachines, type CliStatusSnapshot } from "@/lib/bridge-cli-status";
import { computerAnswerState, isOnline } from "@/lib/devices/presence";
import { pairingCanClaim, type PairedVia } from "@/lib/bridge/pairing-auth";
import { DEPARTMENT_TEST_ASK } from "@/lib/os/channel/reply-budget";
import { CODEX_OASIS_ROLLOUT_MESSAGE, subscriptionRolloutError } from "@/lib/ai/engine-rollout";
import { decryptField, encryptField } from "@/lib/field-encryption";
import { defaultModelFor, isRegistryProvider, modelInfo, saveCheck } from "@/lib/ai/model-registry";
import { probeDepartmentAnswer } from "@/lib/agents/provider-probe";
import { billingForKey, modelCallMeter } from "@/lib/ai/usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNED_OUT = "Your session ended. Sign in again, then try again.";
const fail = (status: number, error: string, message: string) => NextResponse.json({ ok: false, error, message }, { status });
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Scope = "person" | "workspace";
type PairingRow = {
  id: string;
  user_id: string | null;
  label: string | null;
  last_seen_at: string | null;
  claim_enabled_at: string | null;
  paired_via: PairedVia;
  claim_state_at: string | null;
  claim_capacity: unknown;
  claim_blocked_reason: string | null;
  claim_protocols: unknown;
  claim_runtime_state: unknown;
  machine_fingerprint: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return strings(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runtimeRoot(value: unknown): Record<string, unknown> {
  const outer = object(value) ?? {};
  return object(outer.runtime_state) ?? object(outer.runtimes) ?? outer;
}

function engineFor(selection: EngineSelection): RuntimeEngine | null {
  if (selection.mode === "api") return null;
  return selection.mode === "subscription"
    ? { kind: "cli", name: selection.provider }
    : { kind: "local", name: selection.modelRef };
}

function publicSelection(choice: Awaited<ReturnType<typeof readAgentEngine>>, apiProvider: ApiEngineProvider | undefined): unknown {
  return selectionFromChoice(choice, apiProvider) ?? choice;
}

function runtimeInfo(
  root: Record<string, unknown>,
  provider: "claude" | "codex" | "gemini",
  inventory: CliStatusSnapshot | undefined,
  receipt: RuntimeProbeReceipt | undefined,
  savedProof?: SavedRuntimeProbeProof | null,
  requireSavedProof = false,
) {
  const state = object(root[provider]) ?? {};
  const code = typeof state.state === "string" ? state.state : null;
  const inv = inventory?.[provider];
  const installed = state.installed === true || inv?.installed === true;
  const signedIn = state.authenticated === true || inv?.authenticated === true;
  const unsupported = code === "unsupported";
  const proven = requireSavedProof
    ? savedRuntimeProbeProofReady(savedProof, receipt?.pairingId ?? savedProof?.pairingId ?? "", { kind: "cli", name: provider }, receipt)
    : isFreshRuntimeProbeReceipt(receipt);
  // A receipt may bridge the short post-probe heartbeat lag, but it must not
  // override an explicit runtime failure (or an unknown future state).
  const receiptEligibleState = code === null || code === "ready" || code === "probe_required";
  return {
    installed,
    signedIn,
    executionReady: installed && signedIn && !unsupported && receiptEligibleState && proven,
    unsupported,
    version: inv?.version ?? null,
    lastTestedAt: receipt?.ready ? receipt.finishedAt : null,
    code: code === "unsupported" ? "unsupported_personal_sign_in" : code,
  };
}

function localModels(
  root: Record<string, unknown>,
  pairingId: string,
  receipts: ReadonlyMap<string, RuntimeProbeReceipt>,
  savedProof?: SavedRuntimeProbeProof | null,
  requireSavedProof = false,
) {
  const raw = Array.isArray(root.local_models) ? root.local_models : [];
  return raw.flatMap((entry) => {
    const model = object(entry);
    if (!model || typeof model.ref !== "string" || typeof model.label !== "string") return [];
    const adapter = model.adapter === "ollama" || model.adapter === "lmstudio" ? model.adapter : null;
    const state = model.state === "ready" || model.state === "probe_required" || model.state === "unavailable" ? model.state : null;
    if (!adapter || !state) return [];
    const receipt = receipts.get(runtimeProbeReceiptKey(pairingId, { kind: "local", name: model.ref }));
    const proven = requireSavedProof
      ? savedRuntimeProbeProofReady(savedProof, pairingId, { kind: "local", name: model.ref }, receipt)
      : isFreshRuntimeProbeReceipt(receipt);
    const verifiedState = state === "unavailable" ? "unavailable" : proven ? "ready" : "probe_required";
    return [{ ref: model.ref, label: model.label, adapter, state: verifiedState, lastTestedAt: receipt?.ready ? receipt.finishedAt : null }];
  });
}

type EffectiveRuntimeSummary = {
  pairingId: string | null;
  codingHarnessReady: boolean;
  status: string;
};

/**
 * A privacy-safe readiness answer for the effective engine. Members who
 * inherit the workspace default do not receive the agents owner's device
 * inventory, but the coding composer still needs the truth about that exact
 * saved pairing. No label, owner or inventory detail leaves this summary.
 */
function effectiveRuntimeSummary(
  choice: AgentEngineChoice,
  pairings: readonly PairingRow[],
  inventory: ReadonlyMap<string, CliStatusSnapshot>,
  receipts: ReadonlyMap<string, RuntimeProbeReceipt>,
  savedProof: SavedRuntimeProbeProof | null,
  nowMs: number,
): EffectiveRuntimeSummary {
  if (choice.kind === "api") return { pairingId: null, codingHarnessReady: true, status: "ready" };
  const pairingId = choice.pairingId ?? null;
  if (!pairingId) return { pairingId: null, codingHarnessReady: false, status: "computer_choice_required" };
  const pairing = pairings.find((item) => item.id === pairingId);
  if (!pairing) return { pairingId, codingHarnessReady: false, status: "pairing_not_found" };
  if (!pairingCanClaim({ claimEnabledAt: pairing.claim_enabled_at, pairedVia: pairing.paired_via })) {
    return { pairingId, codingHarnessReady: false, status: "approval_needed" };
  }
  const answerState = computerAnswerState(
    {
      claimEnabledAt: pairing.claim_enabled_at,
      claimStateAt: pairing.claim_state_at,
      claimBlockedReason: pairing.claim_blocked_reason,
      claimCapacity: typeof pairing.claim_capacity === "number" ? pairing.claim_capacity : Number(pairing.claim_capacity),
    },
    nowMs,
  );
  if (!isOnline(pairing.last_seen_at, nowMs) || answerState === "offline") {
    return { pairingId, codingHarnessReady: false, status: "offline" };
  }
  if (answerState.startsWith("blocked:")) {
    return { pairingId, codingHarnessReady: false, status: answerState.slice("blocked:".length) || "unavailable" };
  }
  const protocols = strings(pairing.claim_protocols);
  if (!protocols.includes("coding_harness_task_v1")) {
    return { pairingId, codingHarnessReady: false, status: "connector_update_required" };
  }
  const root = runtimeRoot(pairing.claim_runtime_state);
  if (choice.kind === "cli") {
    const info = runtimeInfo(
      root,
      choice.cli,
      inventory.get(pairing.id),
      receipts.get(runtimeProbeReceiptKey(pairing.id, { kind: "cli", name: choice.cli })),
      savedProof,
      true,
    );
    if (info.unsupported) return { pairingId, codingHarnessReady: false, status: "unsupported" };
    if (!info.installed) return { pairingId, codingHarnessReady: false, status: "not_installed" };
    if (!info.signedIn) return { pairingId, codingHarnessReady: false, status: "sign_in_needed" };
    if (!info.executionReady) return { pairingId, codingHarnessReady: false, status: info.code || "needs_test" };
  } else {
    const model = localModels(root, pairing.id, receipts, savedProof, true).find((item) => item.ref === choice.model);
    if (!model) return { pairingId, codingHarnessReady: false, status: "model_not_found" };
    if (model.state !== "ready") return { pairingId, codingHarnessReady: false, status: model.state === "unavailable" ? "offline" : "needs_test" };
  }
  return { pairingId, codingHarnessReady: true, status: answerState === "busy" ? "busy" : "ready" };
}

async function probeReceiptsByPairing(tenantId: string, pairings: readonly PairingRow[]) {
  try {
    return await readLatestRuntimeProbeReceipts(tenantId, pairings.map((pairing) => pairing.id));
  } catch (error) {
    // During the additive rollout, an old database may not have the jobs
    // table yet. Fail closed to Needs test; a heartbeat is never promoted.
    console.error("[ai.engine.probe-receipts]", { tenantId, error: errText(error) });
    return new Map<string, RuntimeProbeReceipt>();
  }
}

function apiSwitchModel(provider: ApiEngineProvider, savedModel: string): string {
  if (savedModel && saveCheck(provider, savedModel).ok && modelInfo(provider, savedModel)) return savedModel;
  return isRegistryProvider(provider) ? defaultModelFor(provider) : savedModel;
}

async function readPairings(tenantId: string): Promise<PairingRow[]> {
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select(
      "id, user_id, label, last_seen_at, claim_enabled_at, paired_via, claim_state_at, claim_capacity, claim_blocked_reason, claim_protocols, claim_runtime_state, machine_fingerprint",
    )
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`engine pairings read failed: ${error.message}`);
  return (data || []) as PairingRow[];
}

async function inventoryByPairing(tenantId: string, pairings: readonly PairingRow[]): Promise<Map<string, CliStatusSnapshot>> {
  const { data, error } = await getServiceSupabase()
    .from("integrations_health")
    .select("metadata, last_ping_at")
    .eq("tenant_id", tenantId)
    .eq("service", CLI_INVENTORY_SERVICE);
  if (error) {
    console.error("[ai.engine.inventory]", error.message);
    return new Map();
  }
  const active = new Map(pairings.map((pairing) => [pairing.id, pairing.label]));
  const out = new Map<string, CliStatusSnapshot>();
  for (const row of (data || []) as Array<{ metadata?: unknown; last_ping_at?: string | null }>) {
    const normalized = normalizeCliMachines(row.metadata, row.last_ping_at, active);
    if (!normalized.ok) continue;
    for (const machine of normalized.machines) if (machine.id) out.set(machine.id, machine.data);
  }
  return out;
}

async function ownerNames(tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await getServiceSupabase()
    .from("user_profiles")
    .select("auth_user_id, display_name, full_name, email")
    .eq("tenant_id", tenantId)
    .is("deactivated_at", null);
  if (error) {
    console.error("[ai.engine.owner_names]", error.message);
    return new Map();
  }
  return new Map(
    ((data || []) as Array<{ auth_user_id?: string; display_name?: string | null; full_name?: string | null; email?: string | null }>).flatMap(
      (row) => (row.auth_user_id ? [[row.auth_user_id, row.display_name || row.full_name || row.email || "Computer owner"] as const] : []),
    ),
  );
}

async function pairingForSelection(input: {
  tenantId: string;
  authUserId: string;
  scope: Scope;
  selection: Exclude<EngineSelection, { mode: "api" }>;
}): Promise<{ ok: true; pairing: PairingRow } | { ok: false; status: number; error: string; message: string }> {
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select(
      "id, user_id, label, last_seen_at, claim_enabled_at, paired_via, claim_state_at, claim_capacity, claim_blocked_reason, claim_protocols, claim_runtime_state, machine_fingerprint",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.selection.pairingId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`engine pairing read failed: ${error.message}`);
  const pairing = data as PairingRow | null;
  if (!pairing) return { ok: false, status: 404, error: "pairing_not_found", message: "That computer is no longer paired. Choose another computer." };
  if (input.scope === "person" && pairing.user_id !== input.authUserId) {
    return { ok: false, status: 403, error: "pairing_not_owned", message: "Your setup can use only a computer paired to your account." };
  }
  if (input.scope === "workspace") {
    const owner = await readAgentsOwner(input.tenantId);
    if (owner.state !== "set" || pairing.user_id !== owner.authUserId) {
      return { ok: false, status: 409, error: "agents_owner_pairing_required", message: "Choose an approved computer owned by this workspace's agents owner." };
    }
  }
  if (!pairingCanClaim({ claimEnabledAt: pairing.claim_enabled_at, pairedVia: pairing.paired_via })) {
    return { ok: false, status: 409, error: "pairing_not_approved", message: "Approve that computer in Devices before using it for agents." };
  }
  const protocols = strings(pairing.claim_protocols);
  if (
    !protocols.includes("runtime_action_v1") ||
    !protocols.includes("department_task_v2") ||
    !protocols.includes("coding_harness_task_v1")
  ) {
    return { ok: false, status: 409, error: "connector_update_required", message: "Update and restart the connector on that computer, then try again." };
  }
  return { ok: true, pairing };
}

function scopeOf(value: unknown, legacyDefault: Scope = "workspace"): Scope | null {
  if (value === undefined) return legacyDefault;
  return value === "person" || value === "workspace" ? value : null;
}

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  const tenantId = ctx.tenantId;
  const canManage = ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess);
  try {
    const [workspaceEngine, workspaceVersion, personEngine, personVersion, account, savedProviders, pairings, oasis, agentsOwner, effectiveEngine] = await Promise.all([
      readAgentEngine(tenantId),
      readAgentEngineVersion(tenantId),
      readPersonAgentEngine(tenantId, ctx.authUserId),
      readPersonAgentEngineVersion(tenantId, ctx.authUserId),
      readWorkspaceAiAccount(tenantId),
      readSavedProviders(tenantId),
      readPairings(tenantId),
      isOasisWorkspace(tenantId),
      readAgentsOwner(tenantId),
      readEffectiveAgentEngineWithProof(tenantId, ctx.authUserId),
    ]);
    // Personal AI Brain is available to every member, but that must not turn
    // into a tenant-wide device directory. Managers need the full inventory
    // for Workspace default; everyone else receives only their own machines.
    const visiblePairings = canManage ? pairings : pairings.filter((pairing) => pairing.user_id === ctx.authUserId);
    const effectiveChoice = effectiveEngine.engine;
    const effectivePairingId = effectiveChoice.kind === "api" ? null : effectiveChoice.pairingId ?? null;
    const hiddenEffectivePairing = effectivePairingId && !visiblePairings.some((pairing) => pairing.id === effectivePairingId)
      ? pairings.find((pairing) => pairing.id === effectivePairingId) ?? null
      : null;
    const [inventory, names, probeReceipts, hiddenInventory, hiddenProbeReceipts] = await Promise.all([
      inventoryByPairing(tenantId, visiblePairings),
      ownerNames(tenantId),
      probeReceiptsByPairing(tenantId, visiblePairings),
      hiddenEffectivePairing ? inventoryByPairing(tenantId, [hiddenEffectivePairing]) : Promise.resolve(new Map<string, CliStatusSnapshot>()),
      hiddenEffectivePairing ? probeReceiptsByPairing(tenantId, [hiddenEffectivePairing]) : Promise.resolve(new Map<string, RuntimeProbeReceipt>()),
    ]);
    for (const [pairingId, snapshot] of hiddenInventory) inventory.set(pairingId, snapshot);
    for (const [key, receipt] of hiddenProbeReceipts) probeReceipts.set(key, receipt);
    const brain = hasUsableKey(account) ? departmentBrain(account) : null;
    const apiProvider = brain?.provider as ApiEngineProvider | undefined;
    const devices = visiblePairings.map((pairing) => {
      const root = runtimeRoot(pairing.claim_runtime_state);
      const inv = inventory.get(pairing.id);
      const lastSeenAt = pairing.last_seen_at;
      const claimState = computerAnswerState(
        {
          claimEnabledAt: pairing.claim_enabled_at,
          claimStateAt: pairing.claim_state_at,
          claimBlockedReason: pairing.claim_blocked_reason,
          claimCapacity: typeof pairing.claim_capacity === "number" ? pairing.claim_capacity : Number(pairing.claim_capacity),
        },
        Date.now(),
      );
      const runtime = (provider: "claude" | "codex" | "gemini") =>
        runtimeInfo(
          root,
          provider,
          inv,
          probeReceipts.get(runtimeProbeReceiptKey(pairing.id, { kind: "cli", name: provider })),
        );
      return {
        pairingId: pairing.id,
        label: pairing.label || "Unnamed computer",
        ownerName: pairing.user_id ? names.get(pairing.user_id) ?? null : null,
        ownedByViewer: pairing.user_id === ctx.authUserId,
        workspaceEligible: agentsOwner.state === "set" && pairing.user_id === agentsOwner.authUserId,
        os: pairing.machine_fingerprint?.match(/windows|mac|linux/i)?.[0] ?? null,
        lastSeenAt,
        approved: pairingCanClaim({ claimEnabledAt: pairing.claim_enabled_at, pairedVia: pairing.paired_via }),
        online: isOnline(lastSeenAt, Date.now()) && claimState !== "offline",
        busy: claimState === "busy",
        protocols: strings(pairing.claim_protocols),
        runtimes: {
          claude: runtime("claude"),
          codex: runtime("codex"),
          gemini: runtime("gemini"),
        },
        localModels: localModels(root, pairing.id, probeReceipts),
      };
    });
    return NextResponse.json(
      {
        ok: true,
        engine: publicSelection(workspaceEngine, apiProvider),
        engineVersion: workspaceVersion,
        engineVersions: { workspace: workspaceVersion, person: personVersion },
        personEngine: {
          source: personEngine ? "person" : "workspace",
          selection: personEngine ? publicSelection(personEngine, apiProvider) : null,
        },
        devices,
        account: brain
          ? { provider: brain.provider, providerLabel: brain.providerLabel, model: brain.savedModel ?? brain.model, modelLabel: brain.modelLabel }
          : null,
        savedProviders,
        effectiveRuntime: effectiveRuntimeSummary(effectiveChoice, pairings, inventory, probeReceipts, effectiveEngine.probeProof, Date.now()),
        bridge: { reachable: devices.some((device) => device.online) },
        workspace: oasis ? "oasis" : "client",
        canManage,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("[ai.engine.read]", { tenantId, error: errText(error) });
    return fail(503, "config_unavailable", "We could not read what powers your agents just now. Refresh to try again.");
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  let raw: { engine?: unknown; scope?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const scope = scopeOf(raw.scope, "person");
  const parsed = selectionFromRequest(raw.engine);
  if (parsed && !parsed.selection && parsed.needsPairing) {
    return fail(409, "computer_choice_needs_pairing", "Choose a computer to finish upgrading this saved setup.");
  }
  const selection = parsed?.selection ?? null;
  if (!scope || !selection || selection.mode === "api") {
    return fail(400, "invalid_engine", "Choose a subscription app or local model on one paired computer to test.");
  }
  if (scope === "workspace" && !(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can test the workspace default.");
  }
  try {
    if (selection.mode === "subscription") {
      const oasis = await isOasisWorkspace(ctx.tenantId);
      if (subscriptionRolloutError(selection.provider, oasis)) {
        return fail(409, "codex_oasis_rollout_only", CODEX_OASIS_ROLLOUT_MESSAGE);
      }
    }
    const checked = await pairingForSelection({ tenantId: ctx.tenantId, authUserId: ctx.authUserId, scope, selection });
    if (!checked.ok) return fail(checked.status, checked.error, checked.message);
    const root = runtimeRoot(checked.pairing.claim_runtime_state);
    const selectedState = selection.mode === "subscription" ? object(root[selection.provider])?.state : null;
    if (selection.mode === "subscription" && selectedState === "unsupported") {
      return fail(409, "unsupported_personal_sign_in", "Gemini CLI cannot use this personal sign-in. Choose a Google API key instead.");
    }
    const engine = engineFor(selection)!;
    const queued = await enqueueRuntimeJob({
      tenantId: ctx.tenantId,
      userId: ctx.authUserId,
      pairingId: checked.pairing.id,
      action: "probe",
      engine,
      prompt: DEPARTMENT_TEST_ASK,
    });
    if (!queued.ok) {
      const status = queued.code === "queue_full" || queued.code === "rate_limited" ? 429 : 409;
      return fail(status, queued.code, "The selected computer could not accept that test. Check its connector, then try again.");
    }
    return NextResponse.json({ ok: true, job_id: queued.job.id }, { status: 202 });
  } catch (error) {
    console.error("[ai.engine.probe]", { tenantId: ctx.tenantId, error: errText(error) });
    return fail(503, "probe_unavailable", "The test could not be queued just now. Nothing was changed.");
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  let raw: {
    engine?: unknown;
    scope?: unknown;
    expected_version?: unknown;
    probe_job_id?: unknown;
    use_workspace_default?: unknown;
  };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const scope = scopeOf(raw.scope, "workspace");
  if (!scope) return fail(400, "invalid_scope", "Choose My setup or Workspace default.");
  if (scope === "workspace" && !(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can change the workspace default.");
  }
  const expected = raw.expected_version;
  if (expected !== null && typeof expected !== "string") {
    return fail(400, "invalid_version", "Refresh AI Brain, then try again.");
  }
  try {
    if (scope === "person" && raw.use_workspace_default === true) {
      const cleared = await clearPersonEngineIfCurrent(ctx.tenantId, ctx.authUserId, expected);
      if (!cleared) return fail(409, "stale_choice", "A newer choice was saved. Refresh AI Brain before changing it.");
      return NextResponse.json({ ok: true, inherited: true });
    }
    const account = await readWorkspaceAiAccount(ctx.tenantId);
    const activeApiProvider = isApiEngineProvider(account?.provider) ? account.provider : undefined;
    const parsed = selectionFromRequest(raw.engine, activeApiProvider);
    if (parsed && !parsed.selection && parsed.needsPairing) {
      return fail(409, "computer_choice_needs_pairing", "Choose a computer to finish upgrading this saved setup.");
    }
    const selection = parsed?.selection ?? null;
    if (!selection) return fail(400, "invalid_engine", "Choose Subscription app, Pure local, or API key.");
    if (selection.mode === "subscription") {
      const oasis = await isOasisWorkspace(ctx.tenantId);
      if (subscriptionRolloutError(selection.provider, oasis)) {
        return fail(409, "codex_oasis_rollout_only", CODEX_OASIS_ROLLOUT_MESSAGE);
      }
    }
    let probeProof: SavedRuntimeProbeProofInput | null = null;
    if (selection.mode === "api") {
      if (!hasUsableKey(account) || account.provider !== selection.provider) {
        // The API account is workspace-wide. A personal engine row may opt
        // into the provider the workspace already uses, but it must never
        // activate a different provider (and therefore change everyone
        // else's spend) while leaving the workspace engine row untouched.
        if (scope !== "workspace") {
          return fail(
            409,
            "api_provider_workspace_scope_required",
            "That API provider is not the workspace account in use. Switch it under Workspace default, or keep My setup on the current workspace provider.",
          );
        }
        if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
          return fail(403, "admin_required", "Only an owner or admin can switch the workspace API account.");
        }
        const [saved, stamp] = await Promise.all([
          readSavedKey(ctx.tenantId, selection.provider),
          readAccountStamp(ctx.tenantId),
        ]);
        if (!saved) {
          return fail(409, "api_provider_not_connected", "Connect that provider key below before putting it in use.");
        }
        const model = apiSwitchModel(selection.provider, saved.model);
        const check = saveCheck(selection.provider, model);
        if (!check.ok) return fail(409, "api_model_unavailable", check.message);
        let key: string;
        try {
          key = decryptField(saved.encryptedApiKey);
        } catch {
          return fail(500, "key_unreadable", "That saved provider key could not be read. Connect it again below.");
        }
        const tested = await probeDepartmentAnswer(selection.provider, key, {
          model,
          meter: modelCallMeter({
            tenantId: ctx.tenantId,
            surface: "probe",
            ...billingForKey(selection.provider, "tenant"),
            userId: ctx.authUserId,
          }),
        });
        if (!tested.ok) {
          return fail(422, "provider_test_failed", `${modelInfo(selection.provider, model)?.label ?? model} did not pass the test. Nothing was changed. ${tested.message}`);
        }
        if (req.signal.aborted) return fail(409, "cancelled", "Stopped before the change finished. Nothing was changed.");
        // Saving key-cache rows is harmless preparation: neither row can
        // answer. Provider activation and the engine CAS happen together
        // below, so a stale tab cannot leave the account and engine split.
        if (hasUsableKey(account) && isApiEngineProvider(account.provider)) {
          await keepSavedKey({
            tenantId: ctx.tenantId,
            provider: account.provider,
            model: account.model,
            encryptedApiKey: account.encryptedApiKey,
          });
        }
        if (saved.source !== "kept") {
          await keepSavedKey({
            tenantId: ctx.tenantId,
            provider: selection.provider,
            model,
            encryptedApiKey: saved.encryptedApiKey,
          });
        }
        const choice = choiceFromSelection(selection);
        const switched = await connectWorkspaceAccountAndEngineInOneStep({
          tenantId: ctx.tenantId,
          stamp,
          provider: selection.provider,
          model,
          encryptedApiKey: encryptField(key),
          agentKeys: [],
          engine: {
            userId: scope === "workspace" ? null : ctx.authUserId,
            expectedVersion: expected,
            choice,
          },
        });
        if (!switched.committed) {
          return fail(409, "stale_choice", "The AI account or engine changed in another window. Refresh AI Brain before trying again.");
        }
        return NextResponse.json({ ok: true, engine: selection });
      }
    } else {
      const checked = await pairingForSelection({ tenantId: ctx.tenantId, authUserId: ctx.authUserId, scope, selection });
      if (!checked.ok) return fail(checked.status, checked.error, checked.message);
      if (selection.fallback === "workspace_api" && !hasUsableKey(account)) {
        return fail(409, "fallback_account_missing", "Connect an API key before enabling API fallback.");
      }
      if (typeof raw.probe_job_id !== "string" || !raw.probe_job_id) {
        return fail(409, "probe_required", "Test this exact app or model on the selected computer before saving it.");
      }
      const job = await readRuntimeJobForOwner(ctx.tenantId, ctx.authUserId, raw.probe_job_id);
      const wanted = engineFor(selection)!;
      const finishedMs = job?.finishedAt ? Date.parse(job.finishedAt) : NaN;
      const probeAgeMs = Date.now() - finishedMs;
      const fresh = Number.isFinite(finishedMs) && probeAgeMs >= 0 && probeAgeMs <= RUNTIME_PROBE_FRESH_MS;
      if (
        !job ||
        job.action !== "probe" ||
        job.status !== "completed" ||
        job.resultCode !== "probe_ok" ||
        !fresh ||
        job.pairingId !== selection.pairingId ||
        job.engine.kind !== wanted.kind ||
        job.engine.name !== wanted.name
      ) {
        return fail(409, "probe_mismatch", "That test is missing, stale, or belongs to another computer or runtime. Test again before saving.");
      }
      probeProof = {
        jobId: job.id,
        pairingId: job.pairingId,
        engine: job.engine,
        verifiedAt: job.finishedAt!,
      };
    }
    const choice = choiceFromSelection(selection);
    const committed =
      scope === "workspace"
        ? await saveAgentEngineIfCurrent(ctx.tenantId, choice, expected, probeProof)
        : await savePersonAgentEngineIfCurrent(ctx.tenantId, ctx.authUserId, choice, expected, probeProof);
    if (!committed) return fail(409, "stale_choice", "A newer choice was saved. Refresh AI Brain before changing it.");
    return NextResponse.json({ ok: true, engine: selection });
  } catch (error) {
    console.error("[ai.engine.write]", { tenantId: ctx.tenantId, error: errText(error) });
    return fail(500, "save_failed", "The choice could not be saved just now. Nothing was changed.");
  }
}
