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
import { prepareAgentTurn, streamAgentTurn } from "@/lib/os/department-agent";
import { groundDepartmentTurn } from "@/lib/os/desk/turn";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";
import { modelFactsForCopy } from "@/lib/ai/model-registry";
import type { AiBudgetCode } from "@/lib/ai/usage";
import { recordTurnOutcome } from "@/lib/os/channel/turns";
import type { Client } from "@libsql/client";
import type { ExecutorDeps, TurnStart } from "./executor";
import type { RunSession } from "./session";
import type { Run } from "./store";
import type { ChatMessage } from "@/lib/providers";

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

export function turnStarterFor(session: RunSession) {
  return async (input: { run: Run; messages: ChatMessage[]; signal: AbortSignal }): Promise<TurnStart> => {
    const { run, messages, signal } = input;
    const prepared = await prepareAgentTurn({
      tenantId: session.scope.tenantId,
      tenantSlug: session.tenantSlug,
      agentSlug: run.agentSlug,
      department: session.dept,
      operator: { name: session.operatorName, email: session.email },
      platformFallback: session.fallback,
      revealModel: session.isOperator,
      // A local model account answers for the verified operator only.
      localModelAllowed: session.isOperator,
      userId: session.scope.userId,
      chatMode: run.chatMode,
      bridge: async () => session.bridge,
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
          viewer: session.viewer,
          chatMode: run.chatMode,
          maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
          plainStream: (dt, msgs, maxTokens) => streamAgentTurn({ ...t, system: dt.system }, msgs, maxTokens, signal),
        })
      : null;
    return {
      ok: true,
      agent: {
        display_name: t.displayName,
        ...(t.department ? { department: t.department.key } : { agent_slug: t.agentSlug }),
        ...(t.revealModel ? { model: t.model } : {}),
        ...(desk ? { tools: desk.tools } : {}),
        // What answered and whose credits it used, for the people who choose
        // it in Settings > AI brain (lib/ai/agent-engine.ts).
        ...(t.revealModel || session.canManageAi
          ? {
              runs_on: t.engine.runsOn,
              spend: t.engine.spend,
              ...(t.engine.fellBackFrom ? { fell_back_from: t.engine.fellBackFrom } : {}),
              ...(t.engine.notUsedFor ? { engine_not_used: t.engine.notUsedFor } : {}),
            }
          : {}),
      },
      channelKey: t.channelKey,
      agentSlug: t.agentSlug,
      failureModel: () => (session.canManageAi || t.revealModel ? modelFactsForCopy(t.provider, t.model) : null),
      stream: desk ? desk.stream(messages) : streamAgentTurn(t, messages, DEPARTMENT_REPLY_MAX_TOKENS, signal),
    };
  };
}
