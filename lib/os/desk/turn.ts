/**
 * lib/os/desk/turn.ts - ground one department turn in the business it works
 * for: the DEPARTMENT STATE block appended to the turn's system prompt, and,
 * where the AI provider can call tools, the department's palette through a
 * real tool loop.
 *
 * Called by app/api/agents/chat/route.ts after prepareAgentTurn
 * (lib/os/department-agent.ts) has resolved the agent, the AI account, the
 * budget and the persona prompt. Nothing here chooses a key or a model: the
 * turn's own provider, model, key and meter are used as they are.
 *
 * FAIL CLOSED ON THE WORKSPACE. The viewer (components/os/department/viewer.ts,
 * the session's rail input) must be the SAME workspace the route resolved, and
 * must be allowed to open the department's page (its gate). Otherwise the turn
 * carries no workspace data and no tools, and its prompt says why, so the
 * model says so too instead of guessing.
 *
 * Provider routing (./catalog.ts deskToolSupport):
 *   anthropic           lib/cloud-tool-runner.ts streamAnthropicWithTools
 *   openai, openrouter  lib/cloud-tool-runner.ts streamOpenAICompatibleWithTools
 *   google              ./gemini-loop.ts streamGeminiWithTools
 *   anything else       the plain stream (the caller's), lookups OFF and said so
 * A turn whose engine is not the hosted API (a connected computer or a local
 * model) also keeps the plain stream.
 */

import "server-only";
import type { OsViewerResult } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import type { OsDepartment } from "@/lib/os/departments";
import type { ChatMessage, Provider, StreamEvent } from "@/lib/providers";
import { openaiReasons, THINKING_HEADROOM_TOKENS } from "@/lib/providers";
import type { ModelCallMeter } from "@/lib/ai/usage";
import {
  streamAnthropicWithTools,
  streamOpenAICompatibleWithTools,
  type StreamYield,
  type ToolContext,
} from "@/lib/cloud-tool-runner";
import { deskPalette, deskToolLabel, deskToolSupport } from "./catalog";
import { loadDepartmentState } from "./state";
import { INJECTION_GUARD } from "@/lib/llm-input-boundary";
import { renderDepartmentState, type DeskStateFacts, type DeskToolsInfo } from "./state-render";
import { deskToolset } from "./tools";
import { streamGeminiWithTools } from "./gemini-loop";

/** The prepared turn's fields this module reads (lib/os/department-agent.ts PreparedTurn). */
export type DeskTurn = {
  tenantId: string;
  agentSlug: string;
  department: OsDepartment | null;
  provider: Provider;
  model: string;
  apiKey: string;
  system: string;
  meter: ModelCallMeter;
  localModelAllowed?: boolean;
  /** Set by the AI-engine work: only `{ kind: "api" }` turns run the tool loop. */
  engine?: { kind: string } | null;
};

export type DeskEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; phase: "start" | "done"; label: string; ok: boolean | null }
  /** usageKnown false: a step reported no usage, so the sums are not the turn's. */
  | { type: "done"; inputTokens: number; outputTokens: number; usageKnown?: boolean }
  | { type: "error"; message: string };

/** What the channel shows about lookups this turn (the `agent` SSE event's `tools`). */
export type DeskToolsNote = { on: boolean; labels: string[]; note: string | null };

export type DeskGrounding = {
  system: string;
  tools: DeskToolsNote;
  stream: (messages: readonly ChatMessage[]) => AsyncGenerator<DeskEvent>;
};

type PlainStream = (turn: DeskTurn, messages: readonly ChatMessage[], maxTokens: number) => AsyncGenerator<StreamEvent>;

export type GroundArgs = {
  turn: DeskTurn;
  viewer: OsViewerResult;
  chatMode?: "plan" | "build";
  maxTokens: number;
  /** The turn's plain stream (lib/os/department-agent.ts streamAgentTurn). */
  plainStream: PlainStream;
  /** Tests inject the state loader. */
  loadState?: typeof loadDepartmentState;
};

function sentence(reason: string): string {
  return reason.charAt(0).toUpperCase() + reason.slice(1) + ".";
}

/** A turn that may not see the workspace: no data, no tools, and the reason in the prompt. */
function ungrounded(args: GroundArgs, dept: OsDepartment, reason: string): DeskGrounding {
  const system =
    args.turn.system +
    `\n\nDEPARTMENT STATE: none this turn: ${reason}. You have no data from this workspace and you cannot look anything up. If asked about the business or what you can do, say exactly that; never guess numbers, names or tools.\n` +
    INJECTION_GUARD;
  return {
    system,
    tools: { on: false, labels: [], note: sentence(reason) },
    stream: (messages) => plain(args, { ...args.turn, system }, messages),
  };
}

async function* plain(args: GroundArgs, turn: DeskTurn, messages: readonly ChatMessage[]): AsyncGenerator<DeskEvent> {
  for await (const ev of args.plainStream(turn, messages, args.maxTokens)) yield ev;
}

async function* fromLoop(source: AsyncGenerator<StreamYield>): AsyncGenerator<DeskEvent> {
  let text = "";
  for await (const ev of source) {
    if (ev.type === "delta") {
      text += ev.text;
      yield ev;
    } else if (ev.type === "tool_use") {
      yield { type: "tool", phase: "start", label: deskToolLabel(ev.name), ok: null };
    } else if (ev.type === "tool_result") {
      yield { type: "tool", phase: "done", label: deskToolLabel(ev.name), ok: ev.ok };
    } else if (ev.type === "done") {
      // A turn with no answer text is a failed turn, here as on every channel.
      if (!text.trim()) {
        yield { type: "error", message: "empty_reply:empty" };
        return;
      }
      yield { type: "done", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, usageKnown: ev.unreportedCalls === 0 };
      return;
    } else if (ev.type === "error") {
      yield ev;
      return;
    } else {
      // A department palette never pauses for the bridge.
      yield { type: "error", message: "stream_failed" };
      return;
    }
  }
}

export async function groundDepartmentTurn(args: GroundArgs): Promise<DeskGrounding | null> {
  const { turn, viewer } = args;
  const dept = turn.department;
  if (!dept) return null;
  if (!viewer.ok || viewer.surface.tenantId !== turn.tenantId) {
    return ungrounded(args, dept, "we could not confirm which workspace this person is in");
  }
  if (departmentGate(dept.slug, viewer.navInput) === null) {
    return ungrounded(args, dept, `this person cannot open the ${dept.label} page, so its data is not shared in this channel`);
  }

  const planMode = args.chatMode === "plan";
  const engineOk = !turn.engine || turn.engine.kind === "api";
  const support = engineOk
    ? deskToolSupport(turn.provider)
    : ({ on: false, reason: "this AI brain runs outside the Command Center, where it cannot look things up in the workspace" } as const);
  let facts: DeskStateFacts;
  try {
    facts = await (args.loadState ?? loadDepartmentState)(viewer, dept);
  } catch (err) {
    // Each read already fails on its own; this is the loader itself breaking.
    console.error("[os.desk.state]", { tenantId: turn.tenantId, department: dept.key, error: err instanceof Error ? err.message : String(err) });
    return ungrounded(args, dept, `the ${dept.label} page could not be read this turn`);
  }
  const palette = deskPalette(dept.key, { planMode });
  const info: DeskToolsInfo = support.on ? { on: true, tools: palette } : { on: false, reason: support.reason, tools: palette };
  const system = turn.system + renderDepartmentState(facts, info);
  const grounded: DeskTurn = { ...turn, system };

  if (!support.on) {
    return {
      system,
      tools: { on: false, labels: [], note: `Looking things up is off: ${support.reason}. Answers use this page's summary only.` },
      stream: (messages) => plain(args, grounded, messages),
    };
  }

  const toolset = deskToolset({ viewer, dept, agentSlug: turn.agentSlug, planMode });
  const ctx: ToolContext = {
    tenantId: viewer.surface.tenantId,
    userId: viewer.surface.userId,
    agentKey: turn.agentSlug,
    authUserId: viewer.authUserId ?? viewer.surface.userId,
    isAdmin: viewer.surface.persona === "founder",
  };
  return {
    system,
    tools: { on: true, labels: toolset.palette.map((t) => t.label), note: null },
    stream: (messages) => {
      const history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      if (turn.provider === "anthropic") {
        return fromLoop(
          streamAnthropicWithTools({ apiKey: turn.apiKey, model: turn.model, system, messages: history, maxTokens: args.maxTokens, meter: turn.meter, toolset }, ctx),
        );
      }
      if (turn.provider === "openai" || turn.provider === "openrouter") {
        // GPT-5.x and the o-series spend reasoning tokens against the cap
        // (lib/providers.ts streamOpenAI): the answer keeps its budget.
        const maxTokens = args.maxTokens + (turn.provider === "openai" && openaiReasons(turn.model) ? THINKING_HEADROOM_TOKENS : 0);
        return fromLoop(
          streamOpenAICompatibleWithTools(
            { provider: turn.provider, apiKey: turn.apiKey, model: turn.model, system, messages: history, maxTokens, meter: turn.meter, toolset },
            ctx,
          ),
        );
      }
      return fromLoop(
        streamGeminiWithTools({ apiKey: turn.apiKey, model: turn.model, system, messages: history, maxTokens: args.maxTokens, meter: turn.meter, toolset }),
      );
    },
  };
}
