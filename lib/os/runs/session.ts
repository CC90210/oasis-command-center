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
import { getSessionUser } from "@/lib/supabase-server";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { operatorPlatformFallback, type OperatorFallback } from "@/lib/operator-credentials";
import { manifestExists } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { operatorNameOverride } from "@/lib/operator-name";
import { isAdminProfile } from "@/lib/lead-scope";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import { readEffectiveEngine, type EffectiveEngine } from "@/lib/ai/agent-engine-store";
import type { AgentEngineChoice } from "@/lib/ai/agent-engine";
import { BRIDGE_REFUSAL_ERROR, bridgeResolutionForSession, type BridgeCaller, type BridgeRefused, type BridgeUnavailable } from "@/lib/ai/bridge-turn";
import { getOwnComputers, type OwnComputer } from "@/lib/queries";
import { bestComputerAnswerState, computerAnswerState, type ComputerAnswerState } from "@/lib/devices/presence";
import { blockedReasonCode } from "@/lib/os/channel/outcome";
import { resolveOsViewer } from "@/components/os/department/viewer";
import type { OsViewerResult } from "@/components/os/department/viewer";
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
  computerDispatch: { label: string } | null;
};

export type SessionRefusal = { ok: false; status: number; error: string };

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
  let effective: EffectiveEngine;
  try {
    effective = await readEffectiveEngine(tenantId, user.id);
  } catch (err) {
    console.error("[os.runs.session.engine]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 503, error: "config_unavailable" };
  }

  // The person explicitly chose THEIR OWN paired computer (O3a's pairing --
  // never the workspace's shared tunnel bridgeResolutionForSession answers
  // below). NO KEY FALLBACK (Adon, 2026-10-11): every state that is not a
  // real answer is refused HERE, before a run is ever queued -- "refused,
  // not queued, not saved, not failed", the same shape O1 uses just below
  // for the workspace engine. It is never answered on the API key, on
  // OpenCode's free models, or on another person's computer.
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
  // is refused here exactly as before O4: letting the run through would
  // either wait on a claim that can never come, or fall through to the
  // workspace engine -- the one silent fallback this rule exists to prevent.
  let computerDispatch: { label: string } | null = null;
  if (effective.source === "person" && effective.kind === "computer") {
    const computers = await getOwnComputers(tenantId, user.id);
    const decision = computerDispatchDecision(bestOwnComputer(computers, Date.now()));
    if (!decision.ok) return { ok: false, status: 409, error: decision.error };
    computerDispatch = { label: decision.label };
  }

  // The person explicitly chose the workspace API key (effective.kind can
  // only be 'api' here: 'computer' was handled, and returned from, above):
  // no bridge lookup at all, so there is no O1 pause risk for them -- exactly
  // like a workspace default of 'api' today. `computerDispatch` already set
  // means the WORKSPACE tunnel (bridge below) is never consulted at all --
  // this person's own computer answers, or the run is refused; the
  // workspace's shared bridge is a different road entirely.
  const engine: AgentEngineChoice = computerDispatch ? { kind: "api" } : effective.source === "person" ? { kind: "api" } : effective.engine;
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
