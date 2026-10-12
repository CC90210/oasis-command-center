/**
 * lib/os/runs/session.ts - who is sending a message into a department channel,
 * resolved ONCE, at the request, into a plain object the driver carries.
 *
 * WHY HERE. A run is finished by a driver that may outlive the request that
 * started it, and a driver must not read cookies or headers: that context is
 * the request's. So everything that needs the session (the person, their active
 * workspace, the department page's viewer, the paired computer's gate) is
 * resolved before the response goes out, and the driver gets values.
 *
 * The rules are the channel route's (app/api/agents/chat/route.ts), unchanged:
 * the workspace is the session's ACTIVE one, a body `tenant_slug` is honoured
 * only for a slug the caller owns, the model id and the platform key are the
 * verified operator's only. This module restates none of them: it calls the
 * same functions.
 */
import "server-only";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { operatorPlatformFallback, type OperatorFallback } from "@/lib/operator-credentials";
import { manifestExists } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { operatorNameOverride } from "@/lib/operator-name";
import { isAdminProfile } from "@/lib/lead-scope";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import { bindLegacyEngineIfUnchanged, readEffectiveAgentEngine, type EffectiveAgentEngine } from "@/lib/ai/agent-engine-store";
import type { AgentEngineChoice } from "@/lib/ai/agent-engine";
import { BRIDGE_REFUSAL_ERROR, bridgeResolutionForSession, type BridgeCaller, type BridgeRefused, type BridgeUnavailable } from "@/lib/ai/bridge-turn";
import { getOwnComputers, type OwnComputer } from "@/lib/queries";
import { bestComputerAnswerState, computerAnswerState, type ComputerAnswerState } from "@/lib/devices/presence";
import { blockedReasonCode } from "@/lib/os/channel/outcome";
import { resolveOsViewer } from "@/components/os/department/viewer";
import type { OsViewerResult } from "@/components/os/department/viewer";
import { readAgentsOwner } from "@/lib/agents-owner";
import { pairingCanClaim, type PairedVia } from "@/lib/bridge/pairing-auth";
import type { RunScope } from "./store";

export type RunSession = {
  scope: RunScope;
  email: string;
  tenantSlug: string;
  dept: OsDepartment;
  operatorName: string;
  /** The verified platform operator: sees the model id, may use the platform key and a local model. */
  isOperator: boolean;
  /** Owner or admin: may change the AI settings, and sees the model's reasoning. */
  canManageAi: boolean;
  fallback: OperatorFallback | null;
  viewer: OsViewerResult;
  /** The paired computer's gate for this person, answered now (null when the engine is the API account). */
  bridge: BridgeCaller | BridgeUnavailable | BridgeRefused | null;
  /**
   * O4: set when this person's effective engine is their OWN paired computer
   * AND it can take the work right now (computerAnswerState 'can_answer' or
   * 'busy' -- send.ts enqueues as executor 'computer' and starts no driver;
   * 'busy' is not a refusal here, it is the claim route's own busy-timeout
   * clock to enforce once queued). null for every other engine. `label` is
   * the best-ranked of this person's own computers, for the "Waiting for
   * {label} to pick this up" / "{label} is finishing another reply" copy.
   */
  computerDispatch: { pairingId: string; label: string; engineKind: "cli" | "local"; engineName: string } | null;
  /** A hosted API choice forced by this person's effective row, rather than the workspace engine row. */
  apiEngineChoice: Extract<AgentEngineChoice, { kind: "api" }> | null;
  /** The exact opted-in device engine that could not execute and was replaced by the workspace API account. */
  fallbackFrom: Exclude<AgentEngineChoice, { kind: "api" }> | null;
};

export type SessionRefusal = { ok: false; status: number; error: string };

type ExactComputer = OwnComputer & {
  userId: string | null;
  claimProtocols: string[];
  claimRuntimeState: unknown;
};

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return stringList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pairedViaForClaim(value: unknown): PairedVia {
  return value === "pair_code" || value === "hmac" || value === "signup_secret" ? value : null;
}

/** Exact pairing lookup for canonical engine rows; never substitutes another machine. */
async function exactComputer(tenantId: string, pairingId: string): Promise<ExactComputer | null> {
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select(
      "id, user_id, label, last_seen_at, revoked_at, scope, paired_via, claim_protocols, claim_enabled_at, claim_state_at, claim_blocked_reason, claim_capacity, claim_runtime_state",
    )
    .eq("tenant_id", tenantId)
    .eq("id", pairingId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`exactComputer: bridge_pairings read failed: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    userId: typeof row.user_id === "string" ? row.user_id : null,
    label: typeof row.label === "string" && row.label.trim() ? row.label : "Unnamed computer",
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
    scope: typeof row.scope === "string" ? row.scope : null,
    pairedVia: pairedViaForClaim(row.paired_via),
    claimEnabledAt: typeof row.claim_enabled_at === "string" ? row.claim_enabled_at : null,
    claimStateAt: typeof row.claim_state_at === "string" ? row.claim_state_at : null,
    claimBlockedReason: typeof row.claim_blocked_reason === "string" ? row.claim_blocked_reason : null,
    claimCapacity: typeof row.claim_capacity === "number" ? row.claim_capacity : row.claim_capacity == null ? null : Number(row.claim_capacity),
    claimProtocols: stringList(row.claim_protocols),
    claimRuntimeState: row.claim_runtime_state,
  };
}

export async function resolveRunSession(input: { department: string }): Promise<{ ok: true; session: RunSession } | SessionRefusal> {
  const user = await getSessionUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  const dept = OS_DEPARTMENTS.find((d) => d.key === input.department) ?? null;
  if (!dept) return { ok: false, status: 400, error: "unknown_department" };

  const resolved = await resolveActiveProfileForUser(user);
  if (resolved.error) return { ok: false, status: 503, error: "profile_unavailable" };
  const profile = resolved.profile;
  if (!profile?.tenant_id) return { ok: false, status: 403, error: "no_tenant" };
  const tenantId = profile.tenant_id;

  const tenantSlug = ((await resolveOwnedSlug(tenantId)) || "").toLowerCase() || null;
  if (!tenantSlug || !(await manifestExists(tenantSlug))) return { ok: false, status: 400, error: "unknown_tenant" };

  const isOperator = await isPlatformOperatorForAuthUser(user.id, user.email);
  const operatorName =
    operatorNameOverride({ authUserId: user.id, email: user.email }) || profile.display_name || profile.full_name || "Operator";

  // O3b: EFFECTIVE ENGINE -- this person's own choice, if they made one
  // (agent_model_config, user_id = them), else the workspace's (readAgentEngine
  // inside this, unchanged: O1's pause below still covers it exactly as before,
  // so a person who never chose for themselves sees NO behaviour change).
  // A failed read is "we could not confirm how you chose to run", never an
  // invented API choice: a person who chose their own computer must not be
  // answered on a key because the read blipped (Codex review, O3b P1).
  let effective: EffectiveAgentEngine;
  try {
    effective = await readEffectiveAgentEngine(tenantId, user.id);
  } catch (err) {
    console.error("[os.runs.session.engine]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 503, error: "config_unavailable" };
  }

  // The person explicitly chose THEIR OWN paired computer (O3a's pairing --
  // never the workspace's shared tunnel bridgeResolutionForSession answers
  // below). NO SILENT KEY FALLBACK: every state that is not a real answer is
  // refused HERE before a run is queued unless this exact saved selection
  // explicitly opted into `workspace_api`. That opt-in can use only the
  // workspace account; never a platform key or another computer.
  //
  // 'can_answer' and 'busy' are NOT refused (O4 replaces the old blanket
  // refusal with real dispatch): send.ts enqueues executor 'computer' and
  // starts no driver, and the claim route's own clocks (computer_not_answering
  // after 20 s first-in-line with no live claimer; computer_busy_timeout
  // after 5 minutes first-in-line behind a busy computer; a 10-minute
  // absolute cap) decide, once queued, whether it was ever truly answered.
  // A follow-up waiting behind a long reply in the SAME conversation is
  // never penalised for that wait (the clock starts at first-in-line, not at
  // send). Every other state ('not_approved', 'offline', any 'blocked:<r>')
  // is refused here by default. The explicit fallback policy turns only
  // those operational readiness failures into a labelled workspace-API run.
  let computerDispatch: RunSession["computerDispatch"] = null;
  const selectedEngine = effective.engine;
  let apiEngineChoice: RunSession["apiEngineChoice"] = selectedEngine.kind === "api" ? selectedEngine : null;
  let fallbackFrom: RunSession["fallbackFrom"] = null;
  if (selectedEngine.kind !== "api") {
    const engineKind = selectedEngine.kind === "cli" ? "cli" : "local";
    const engineName = selectedEngine.kind === "cli" ? selectedEngine.cli : selectedEngine.model;
    if (selectedEngine.pairingId) {
      const computer = await exactComputer(tenantId, selectedEngine.pairingId);
      if (!computer) return { ok: false, status: 409, error: "computer_not_connected" };
      if (effective.source === "person" && computer.userId !== user.id) {
        return { ok: false, status: 403, error: "computer_not_yours" };
      }
      if (effective.source === "workspace") {
        const owner = await readAgentsOwner(tenantId);
        if (owner.state !== "set" || computer.userId !== owner.authUserId) {
          return { ok: false, status: 409, error: owner.state === "unavailable" ? "computer_owner_unavailable" : "computer_owner_not_set" };
        }
      }
      const readiness = computer.claimProtocols.includes("department_task_v2")
        ? runtimeDispatchDecision(computer, { kind: engineKind, name: engineName }, computer.claimRuntimeState, Date.now())
        : ({ ok: false, error: "department_profile_unsupported" } as const);
      const dispatch = runtimeFallbackDecision(selectedEngine, readiness);
      if (!dispatch.ok) return { ok: false, status: 409, error: dispatch.error };
      if (dispatch.mode === "computer") {
        computerDispatch = { pairingId: computer.id, label: dispatch.label, engineKind, engineName };
      } else {
        apiEngineChoice = { kind: "api" };
        fallbackFrom = dispatch.fallbackFrom;
      }
    } else {
      // Legacy unbound rows survive rollout. They become canonical only when
      // exactly one approved computer can really run this selected engine via
      // department_task_v2. Zero, multiple, v1-only, or unprobed candidates
      // require an explicit computer choice in AI Brain.
      let candidateUserId = user.id;
      if (effective.source === "workspace") {
        const owner = await readAgentsOwner(tenantId);
        if (owner.state !== "set") {
          return { ok: false, status: 409, error: owner.state === "unavailable" ? "computer_owner_unavailable" : "computer_owner_not_set" };
        }
        candidateUserId = owner.authUserId;
      }
      const owned = await getOwnComputers(tenantId, candidateUserId);
      const candidates = (
        await Promise.all(owned.map((computer) => exactComputer(tenantId, computer.id)))
      ).filter((computer): computer is ExactComputer => computer !== null && computer.userId === candidateUserId);
      const candidate = selectLegacyBindingCandidate(candidates, { kind: engineKind, name: engineName }, Date.now());
      if (!candidate) return { ok: false, status: 409, error: "computer_choice_needs_pairing" };
      let persisted = false;
      try {
        persisted = await bindLegacyEngineIfUnchanged({
          tenantId,
          userId: effective.source === "person" ? user.id : null,
          engine: selectedEngine,
          pairingId: candidate.id,
        });
      } catch (err) {
        console.error("[os.runs.session.legacy-bind]", {
          tenantId,
          pairingId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, status: 503, error: "config_unavailable" };
      }
      if (!persisted) return { ok: false, status: 409, error: "computer_choice_needs_pairing" };
      computerDispatch = { pairingId: candidate.id, label: candidate.label, engineKind, engineName };
    }
  }

  // The person explicitly chose the workspace API key (effective.kind can
  // only be 'api' here: 'computer' was handled, and returned from, above):
  // no bridge lookup at all, so there is no O1 pause risk for them -- exactly
  // like a workspace default of 'api' today. `computerDispatch` already set
  // means the WORKSPACE tunnel (bridge below) is never consulted at all --
  // this person's own computer answers, or the run is refused; the
  // workspace's shared bridge is a different road entirely.
  const engine: AgentEngineChoice = computerDispatch ? { kind: "api" } : apiEngineChoice ?? selectedEngine;
  const bridge = !computerDispatch && engine.kind !== "api" ? await bridgeResolutionForSession(tenantId) : null;

  // O1: PAUSE, NOT FALLBACK. prepareAgentTurn (called later, inside
  // sendMessage -> executeRun, via turnStarterFor) would refuse this the same
  // way with no fallback — but a run is already QUEUED by then (lib/os/runs/
  // send.ts), so a refusal there reads as a failed run, not a thing that
  // never happened. Catching it here, before sendMessage is ever called,
  // means a non-owner's message never becomes a run row at all: refused, not
  // queued, not saved, not failed.
  if (bridge && "refused" in bridge) {
    return { ok: false, status: 409, error: BRIDGE_REFUSAL_ERROR[bridge.refused] };
  }

  return {
    ok: true,
    session: {
      scope: { tenantId, userId: user.id },
      email: user.email || "",
      tenantSlug,
      dept,
      operatorName,
      isOperator,
      canManageAi: isAdminProfile(profile),
      fallback: isOperator ? operatorPlatformFallback() : null,
      viewer: await resolveOsViewer(),
      bridge,
      computerDispatch,
      apiEngineChoice,
      fallbackFrom,
    },
  };
}

/** Whether this person sees the model's reasoning: the people who choose the model, and the verified operator. */
export function mayWatchThinking(s: Pick<RunSession, "isOperator" | "canManageAi">): boolean {
  return s.isOperator || s.canManageAi;
}

/**
 * The best-ranked of this person's own paired computers, by the SAME ranking
 * lib/devices/presence.ts bestComputerAnswerState uses, WITH the computer it
 * came from, for the label a refusal or a "waiting" message names. null only
 * when the person has no paired computer at all. Exported for its own
 * direct test (tests/computer-dispatch-session.test.ts): this one function,
 * plus the if/else above it, is where NO KEY FALLBACK actually lives.
 */
export function bestOwnComputer(computers: readonly OwnComputer[], nowMs: number): { computer: OwnComputer; state: ComputerAnswerState } | null {
  if (computers.length === 0) return null;
  const states = computers.map((c) => computerAnswerState(c, nowMs));
  const best = bestComputerAnswerState(states);
  const i = states.indexOf(best);
  return { computer: computers[i], state: best };
}

/**
 * NO KEY FALLBACK (Adon, 2026-10-11), as one pure mapping: 'can_answer' and
 * 'busy' are the only states that dispatch; every other state -- no
 * computer at all, 'not_approved', 'offline', any 'blocked:<reason>' -- is a
 * named refusal, never a silent fall-through to the workspace engine. Pure,
 * so its own test exercises every branch without a session, a database, or
 * a mocked getOwnComputers.
 */
export function computerDispatchDecision(
  best: { computer: OwnComputer; state: ComputerAnswerState } | null,
): { ok: true; label: string } | { ok: false; error: string } {
  if (!best) return { ok: false, error: "computer_not_connected" };
  if (best.state === "not_approved") return { ok: false, error: "computer_not_approved" };
  if (best.state === "offline") return { ok: false, error: "computer_offline" };
  if (best.state.startsWith("blocked:")) return { ok: false, error: blockedReasonCode(best.state.slice("blocked:".length)) };
  return { ok: true, label: best.computer.label };
}

type RuntimeRef = { kind: "cli" | "local"; name: string };

function runtimeStateObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return runtimeStateObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The connector's last runtime-specific execution verdict for one engine. */
export function runtimeExecutionState(value: unknown, engine: RuntimeRef): string | null {
  const outer = runtimeStateObject(value);
  if (!outer) return null;
  const runtimes = runtimeStateObject(outer.runtime_state) ?? runtimeStateObject(outer.runtimes) ?? outer;
  if (engine.kind === "cli") {
    const entry = runtimeStateObject(runtimes[engine.name]);
    return typeof entry?.state === "string" ? entry.state : null;
  }
  const models = Array.isArray(runtimes.local_models)
    ? runtimes.local_models
    : Array.isArray(outer.local_models)
      ? outer.local_models
      : [];
  for (const raw of models) {
    const model = runtimeStateObject(raw);
    if (model?.ref === engine.name) return typeof model.state === "string" ? model.state : "probe_required";
  }
  return "not_installed";
}

type RuntimeDispatch = { ok: true; label: string } | { ok: false; error: string };

/**
 * Convert a failed exact-device readiness check into a workspace-API turn
 * only when that saved engine explicitly opted in. Ownership and tenancy are
 * checked before this helper is called, so those security failures never
 * become API spend.
 */
export function runtimeFallbackDecision(
  engine: Exclude<AgentEngineChoice, { kind: "api" }>,
  decision: RuntimeDispatch,
):
  | { ok: true; mode: "computer"; label: string }
  | { ok: true; mode: "workspace_api"; fallbackFrom: Exclude<AgentEngineChoice, { kind: "api" }>; reason: string }
  | { ok: false; error: string } {
  if (decision.ok) return { ok: true, mode: "computer", label: decision.label };
  // Approval/ownership are authorization boundaries, not availability
  // failures. They must never be converted into spend on a different engine.
  if (
    decision.error === "computer_not_approved" ||
    decision.error === "computer_not_yours" ||
    decision.error === "computer_owner_not_set" ||
    decision.error === "computer_owner_unavailable"
  ) {
    return decision;
  }
  if (engine.fallback !== "workspace_api") return decision;
  return { ok: true, mode: "workspace_api", fallbackFrom: engine, reason: decision.error };
}

/** Exact-device gate: generic computer liveness plus a real probe of the selected runtime. */
export function runtimeDispatchDecision(
  computer: OwnComputer,
  engine: RuntimeRef,
  runtimeState: unknown,
  nowMs: number,
): { ok: true; label: string } | { ok: false; error: string } {
  if (!pairingCanClaim({ claimEnabledAt: computer.claimEnabledAt, pairedVia: pairedViaForClaim(computer.pairedVia) })) {
    return { ok: false, error: "computer_not_approved" };
  }
  const available = computerDispatchDecision({ computer, state: computerAnswerState(computer, nowMs) });
  if (!available.ok) return available;
  const state = runtimeExecutionState(runtimeState, engine);
  if (state === "ready") return available;
  if (state === "unsupported") return { ok: false, error: "cli_account_unsupported" };
  if (state === "needs_sign_in") return { ok: false, error: "subscription_auth_failure" };
  if (state === "not_installed") return { ok: false, error: "cli_not_found" };
  return { ok: false, error: "department_profile_unsupported" };
}

type LegacyBindingComputer = OwnComputer & { claimProtocols: string[]; claimRuntimeState: unknown };

/** The one safe automatic rollout upgrade: exactly one v2 computer with a fresh real runtime probe. */
export function selectLegacyBindingCandidate<T extends LegacyBindingComputer>(
  computers: readonly T[],
  engine: RuntimeRef,
  nowMs: number,
): T | null {
  const compatible = computers.filter(
    (computer) =>
      pairingCanClaim({ claimEnabledAt: computer.claimEnabledAt, pairedVia: pairedViaForClaim(computer.pairedVia) }) &&
      computer.claimProtocols.includes("department_task_v2") &&
      runtimeDispatchDecision(computer, engine, computer.claimRuntimeState, nowMs).ok,
  );
  return compatible.length === 1 ? compatible[0] : null;
}
