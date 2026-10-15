/**
 * A guided automation's cloud department turn. The caller has already
 * revalidated the owner and workspace; this module fixes the remaining
 * authority at the model boundary: one department, one server-built task,
 * one tool allowlist, no history, and preview-only proposal behavior when
 * testing.
 */
import "server-only";

import type { ChatMessage } from "@/lib/providers";
import { prepareAgentTurn, streamAgentTurn } from "@/lib/os/department-agent";
import { groundDepartmentTurn } from "@/lib/os/desk/turn";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";
import { modelFactsForCopy } from "@/lib/ai/model-registry";
import { DESK_TOOLS } from "@/lib/os/desk/catalog";
import { taskMessageFor } from "@/lib/automations/guided/validate";
import { redactAll } from "@/lib/secret-redaction";
import type { GuidedPayload } from "@/lib/automations/guided/types";
import type { RunSession } from "./session";
import type { Run } from "./store";
import type { TurnStart } from "./executor";
import { engineMetadataForTurn } from "./turn-starter";

export type WouldDraft = { to: string; subject: string; title: string; body: string };

type AutomationTurnDeps = {
  prepare?: typeof prepareAgentTurn;
  ground?: typeof groundDepartmentTurn;
  stream?: typeof streamAgentTurn;
};

export type StartAutomationTurnInput = {
  session: RunSession;
  payload: GuidedPayload;
  mode: "live" | "preview";
  automationId: string;
  automationName: string;
  run: Run;
  signal: AbortSignal;
  wouldDraft: WouldDraft[];
  deps?: AutomationTurnDeps;
};

function preparationFailure(error: string): string {
  if (error === "department_agent_mismatch" || error === "agent_not_found" || error === "agent_not_visible") {
    return "department_unavailable";
  }
  if (
    error === "agent_not_configured" ||
    error === "key_unreadable" ||
    error === "config_unavailable" ||
    error === "ai_usage_unavailable" ||
    error === "ai_budget_exhausted" ||
    error === "ai_budget_unpriced_model"
  ) {
    return "ai_account_unavailable";
  }
  return "sources_unavailable";
}

function collectWouldDraft(target: WouldDraft[], name: string, content: string): void {
  if (name !== "propose_email") return;
  try {
    const parsed = JSON.parse(content) as { would_draft?: unknown };
    const draft = parsed.would_draft;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return;
    const value = draft as Record<string, unknown>;
    if (typeof value.to !== "string" || typeof value.subject !== "string" || typeof value.title !== "string") return;
    target.push({ to: value.to, subject: value.subject, title: value.title, body: typeof value.body === "string" ? value.body.slice(0, 4_000) : "" });
  } catch {
    // A malformed tool result remains a tool failure; it never widens rights.
  }
}

/** Start one guided automation turn. Browser text and earlier run output are
 * deliberately absent: the only user message is taskMessageFor(payload). */
export async function startAutomationTurn(input: StartAutomationTurnInput): Promise<TurnStart> {
  const { session, payload, run, signal } = input;
  const built = taskMessageFor(payload);
  if (!built) return { ok: false, status: 409, error: "template_version_unknown" };
  // The owner's words are stored and later sent to a model provider. Create refuses text that looks
  // like a secret; this scrub is the last boundary, for a value that became a secret after it was saved.
  const task = redactAll(built);
  if (session.dept.key !== payload.department || run.department !== payload.department) {
    return { ok: false, status: 409, error: "department_unavailable" };
  }
  // The catalogue currently contains reads and the one proposal-only draft.
  // Re-check at the last boundary so a future catalogue edit cannot silently
  // introduce a sender, editor, charge or delete tool into unattended work.
  if (payload.tools.some((name) => !DESK_TOOLS[name] || !["read", "proposal"].includes(DESK_TOOLS[name].kind))) {
    return { ok: false, status: 409, error: "tools_invalid" };
  }

  const prepare = input.deps?.prepare ?? prepareAgentTurn;
  const prepared = await prepare({
    tenantId: session.scope.tenantId,
    tenantSlug: session.tenantSlug,
    agentSlug: run.agentSlug,
    department: session.dept,
    operator: { name: session.operatorName, email: session.email },
    platformFallback: null,
    revealModel: session.isOperator,
    userId: session.scope.userId,
    jobId: run.id,
    surface: "automations.run",
    chatMode: "build",
    localModelAllowed: false,
    bridge: null,
    engineChoice: session.apiEngineChoice ?? { kind: "api" },
    apiAccountSnapshot: session.apiAccountSnapshot,
    fallbackFrom: null,
    failClosedWithoutComputerDispatch: true,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      status: prepared.status,
      error: preparationFailure(prepared.error),
      agentSlug: prepared.agentSlug,
      channelKey: prepared.channelKey,
    };
  }
  const turn = prepared.turn;
  if (!turn.department || turn.engine.kind !== "api") {
    return { ok: false, status: 409, error: "ai_account_unavailable" };
  }

  const ground = input.deps?.ground ?? groundDepartmentTurn;
  const plain = input.deps?.stream ?? streamAgentTurn;
  const desk = await ground({
    turn,
    viewer: session.viewer,
    chatMode: "build",
    maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
    only: payload.tools,
    stateAllow: payload.tools,
    proposal: {
      mode: input.mode,
      automationId: input.automationId,
      automationName: input.automationName,
    },
    onToolResult: (name, result) => collectWouldDraft(input.wouldDraft, name, result.content),
    plainStream: (deskTurn, messages, maxTokens) => plain({ ...turn, system: deskTurn.system }, messages, maxTokens, signal),
  });
  if (!desk || !desk.tools.on) {
    return {
      ok: false,
      status: 503,
      error: "sources_unavailable",
      agentSlug: turn.agentSlug,
      channelKey: turn.channelKey,
    };
  }

  const messages: ChatMessage[] = [{ role: "user", content: task }];
  return {
    ok: true,
    agent: {
      display_name: turn.displayName,
      department: payload.department,
      tools: desk.tools,
      ...engineMetadataForTurn(turn, session.canManageAi),
    },
    channelKey: turn.channelKey,
    agentSlug: turn.agentSlug,
    failureModel: () => (session.canManageAi || turn.revealModel ? modelFactsForCopy(turn.provider, turn.model) : null),
    stream: desk.stream(messages),
  };
}
