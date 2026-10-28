/**
 * lib/os/runs/turn-starter.ts - how a run starts its model turn: the same
 * calls the channel route has always made, with the session already resolved
 * (./session.ts).
 *
 *   prepareAgentTurn   the department binding, the agent, the workspace's AI
 *                      account (or the platform key for the operator), the
 *                      month's budget, the prompt, the meter;
 *   groundDepartmentTurn  the page's numbers and the palette of lookups where
 *                      the provider can call tools;
 *   streamAgentTurn    the plain stream (a hosted model, or the paired
 *                      computer).
 *
 * Nothing here chooses a key, a model or a prompt: that is the shared turn
 * (lib/os/department-agent.ts), so the web channel, a Slack mention and a run
 * follow one set of rules. The stop signal reaches a turn on the paired
 * computer, where it closes the request the app is answering.
 */
import "server-only";
import { prepareAgentTurn, streamAgentTurn, type PreparedTurn } from "@/lib/os/department-agent";
import { groundDepartmentTurn } from "@/lib/os/desk/turn";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";
import { modelFactsForCopy } from "@/lib/ai/model-registry";
import type { AiBudgetCode } from "@/lib/ai/usage";
import { recordTurnOutcome } from "@/lib/os/channel/turns";
import type { Client } from "@libsql/client";
import type { ExecutorDeps, TurnStart } from "./executor";
import { validateQueuedFallbackAuthorization, type RunSession } from "./session";
import type { Run, RunApiSnapshot } from "./store";
import type { ChatMessage, StreamEvent } from "@/lib/providers";
import { isApiEngineProvider, isCliEngine, isLocalModelName, workspaceApiFallbackReplyLabel } from "@/lib/ai/agent-engine";
import { isWorkspaceApiFallbackReason } from "./types";

type QueuedSessionResult = { ok: true; session: RunSession } | { ok: false; error: string };

function storedApiSnapshot(run: Run): RunApiSnapshot | null {
  const model = run.runtimeApiModel?.trim() ?? "";
  return isApiEngineProvider(run.runtimeApiProvider) && model
    ? { provider: run.runtimeApiProvider, model }
    : null;
}

async function* withWorkspaceFallbackLabel(
  stream: AsyncGenerator<StreamEvent>,
  fellBackFrom: string | null,
): AsyncGenerator<StreamEvent> {
  if (fellBackFrom) yield { type: "delta", text: workspaceApiFallbackReplyLabel(fellBackFrom) };
  yield* stream;
}

/**
 * Rebuild only the engine-facing part of a request session from the immutable
 * row that was actually claimed. Conversation/user/department authority is
 * unchanged, but a later queued run can never inherit the provider, model or
 * fallback identity of the request that happened to start the driver.
 *
 * Rows without any runtime snapshot are pre-migration/automation rows and
 * keep the supplied session for rollout compatibility. A partial or malformed
 * new snapshot fails closed.
 */
export function sessionForQueuedRun(base: RunSession, run: Run): QueuedSessionResult {
  const api = storedApiSnapshot(run);
  const hasApiParts = run.runtimeApiProvider !== null || run.runtimeApiModel !== null;

  if (run.runtimeEngineKind === "api") {
    if (!api || run.runtimeEngineName !== api.provider || run.targetPairingId !== null) {
      return { ok: false, error: "runtime_api_snapshot_invalid" };
    }
    return {
      ok: true,
      session: {
        ...base,
        bridge: null,
        computerDispatch: null,
        apiEngineChoice: { kind: "api", provider: api.provider },
        apiAccountSnapshot: api,
        fallbackFrom: null,
        fallbackReason: null,
      },
    };
  }

  if (run.runtimeFallbackReason !== null) {
    if (
      !api ||
      !run.targetPairingId ||
      run.runtimeFallbackPolicy !== "workspace_api" ||
      !isWorkspaceApiFallbackReason(run.runtimeFallbackReason)
    ) {
      return { ok: false, error: "runtime_fallback_snapshot_invalid" };
    }
    const fallbackFrom =
      run.runtimeEngineKind === "cli" && isCliEngine(run.runtimeEngineName)
        ? {
            kind: "cli" as const,
            cli: run.runtimeEngineName,
            pairingId: run.targetPairingId,
            fallback: "workspace_api" as const,
          }
        : run.runtimeEngineKind === "local" && isLocalModelName(run.runtimeEngineName)
          ? {
              kind: "local" as const,
              model: run.runtimeEngineName,
              pairingId: run.targetPairingId,
              fallback: "workspace_api" as const,
            }
          : null;
    if (!fallbackFrom) return { ok: false, error: "runtime_fallback_snapshot_invalid" };
    return {
      ok: true,
      session: {
        ...base,
        fallback: null,
        bridge: null,
        computerDispatch: null,
        apiEngineChoice: { kind: "api", provider: api.provider },
        apiAccountSnapshot: api,
        fallbackFrom,
        fallbackReason: run.runtimeFallbackReason,
      },
    };
  }

  if (hasApiParts || run.runtimeEngineKind !== null || run.runtimeEngineName !== null) {
    return { ok: false, error: "runtime_engine_snapshot_invalid" };
  }
  return { ok: true, session: base };
}

/** Everything the driver needs for this person's runs: the database, the turn, and where outcomes are recorded. */
export function executorDepsFor(session: RunSession, db: Client): ExecutorDeps {
  return {
    db,
    scope: session.scope,
    departmentLabel: session.dept.label,
    startTurn: turnStarterFor(session),
    // The channel's last turn (lib/os/channel/turns.ts): never fails the run.
    recordOutcome: async (o) => {
      await recordTurnOutcome(db, {
        tenantId: session.scope.tenantId,
        channelKey: o.channelKey,
        agentSlug: o.agentSlug,
        ok: o.ok,
        code: o.code,
        at: new Date().toISOString(),
      });
    },
  };
}

/** Engine fields for the run's public agent event. Fallback spend is always disclosed. */
export function engineMetadataForTurn(
  turn: Pick<PreparedTurn, "revealModel" | "model" | "engine">,
  canManageAi: boolean,
  fallbackReason?: string | null,
): Record<string, unknown> {
  if (!turn.revealModel && !canManageAi && !turn.engine.fellBackFrom) return {};
  return {
    ...(turn.revealModel ? { model: turn.model } : {}),
    runs_on: turn.engine.runsOn,
    spend: turn.engine.spend,
    ...(turn.engine.fellBackFrom ? { fell_back_from: turn.engine.fellBackFrom } : {}),
    ...(turn.engine.fellBackFrom && fallbackReason ? { fallback_reason: fallbackReason } : {}),
    ...(turn.engine.notUsedFor ? { engine_not_used: turn.engine.notUsedFor } : {}),
  };
}

export function turnStarterFor(session: RunSession) {
  return async (input: { run: Run; messages: ChatMessage[]; signal: AbortSignal }): Promise<TurnStart> => {
    const { run, messages, signal } = input;
    const rebuilt = sessionForQueuedRun(session, run);
    if (!rebuilt.ok) return { ok: false, status: 409, error: rebuilt.error };
    const runSession = rebuilt.session;
    if (runSession.fallbackFrom) {
      const targetPairingId = runSession.fallbackFrom.pairingId;
      if (!targetPairingId) return { ok: false, status: 409, error: "runtime_fallback_snapshot_invalid" };
      const authorization = await validateQueuedFallbackAuthorization({
        tenantId: runSession.scope.tenantId,
        userId: runSession.scope.userId,
        targetPairingId,
      });
      if (!authorization.ok) {
        return { ok: false, status: authorization.status, error: authorization.error };
      }
    }
    const prepared = await prepareAgentTurn({
      tenantId: runSession.scope.tenantId,
      tenantSlug: runSession.tenantSlug,
      agentSlug: run.agentSlug,
      department: runSession.dept,
      operator: { name: runSession.operatorName, email: runSession.email },
      // An opted-in device fallback may spend only this workspace's account;
      // never borrow the operator platform key when that account is absent.
      platformFallback: runSession.fallbackFrom ? null : runSession.fallback,
      revealModel: runSession.isOperator,
      // A local model account answers for the verified operator only.
      localModelAllowed: runSession.isOperator,
      userId: runSession.scope.userId,
      chatMode: run.chatMode,
      bridge: async () => runSession.bridge,
      engineChoice: runSession.apiEngineChoice,
      apiAccountSnapshot: runSession.apiAccountSnapshot,
      fallbackFrom: runSession.fallbackFrom,
      // The training notes this turn reads are the ones its question matches.
      trainingQuery: run.userText,
    });
    if (!prepared.ok) {
      return {
        ok: false,
        status: prepared.status,
        // The month's budget is answered under its own code, as the route did.
        error: prepared.status === 402 ? (prepared.error as AiBudgetCode) : prepared.error,
        recordAs: prepared.recordAs,
        agentSlug: prepared.agentSlug,
        channelKey: prepared.channelKey,
      };
    }
    const t = prepared.turn;
    const desk = t.department
      ? await groundDepartmentTurn({
          turn: t,
          viewer: runSession.viewer,
          chatMode: run.chatMode,
          maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
          plainStream: (dt, msgs, maxTokens) => streamAgentTurn({ ...t, system: dt.system }, msgs, maxTokens, signal),
      })
      : null;
    const answerStream = desk ? desk.stream(messages) : streamAgentTurn(t, messages, DEPARTMENT_REPLY_MAX_TOKENS, signal);
    return {
      ok: true,
      agent: {
        display_name: t.displayName,
        ...(t.department ? { department: t.department.key } : { agent_slug: t.agentSlug }),
        ...(desk ? { tools: desk.tools } : {}),
        // What answered and whose credits it used, for the people who choose
        // it in Settings > AI brain (lib/ai/agent-engine.ts).
        ...engineMetadataForTurn(t, runSession.canManageAi, runSession.fallbackReason),
      },
      channelKey: t.channelKey,
      agentSlug: t.agentSlug,
      failureModel: () => (runSession.canManageAi || t.revealModel ? modelFactsForCopy(t.provider, t.model) : null),
      // Disclosure is part of the durable reply, not optional UI metadata:
      // every browser, Slack approval and replay sees that API credits were
      // spent because the exact selected computer could not answer.
      stream: withWorkspaceFallbackLabel(
        answerStream,
        t.engine.kind === "api" ? t.engine.fellBackFrom : null,
      ),
    };
  };
}
