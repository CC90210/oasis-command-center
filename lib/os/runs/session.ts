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
import { getOwnComputers } from "@/lib/queries";
import { personComputerRefusal } from "@/lib/devices/presence";
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
  // below). NO KEY FALLBACK (Adon, 2026-10-11): every state that is not a real
  // answer is refused here, before a run is ever queued -- "refused, not
  // queued, not saved, not failed", the same shape O1 uses just below for the
  // workspace engine. 'can_answer' is refused too, honestly: nothing
  // downstream of this function (prepareAgentTurn, the driver) yet knows how
  // to run a turn ON a person's own computer -- that is O4's pull dispatch.
  // Letting the run through here would either hang waiting for a claim that
  // never comes, or fall through to whatever the WORKSPACE engine happens to
  // be, which is exactly the silent-fallback this rule exists to prevent.
  if (effective.source === "person" && effective.kind === "computer") {
    const computers = await getOwnComputers(tenantId, user.id);
    return { ok: false, status: 409, error: personComputerRefusal(computers, Date.now()) };
  }

  // The person explicitly chose the workspace API key: no bridge lookup at
  // all, so there is no O1 pause risk for them -- exactly like a workspace
  // default of 'api' today.
  const engine: AgentEngineChoice = effective.source === "person" ? { kind: "api" } : effective.engine;
  const bridge = engine.kind !== "api" ? await bridgeResolutionForSession(tenantId) : null;

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
    },
  };
}

/** Whether this person sees the model's reasoning: the people who choose the model, and the verified operator. */
export function mayWatchThinking(s: Pick<RunSession, "isOperator" | "canManageAi">): boolean {
  return s.isOperator || s.canManageAi;
}
