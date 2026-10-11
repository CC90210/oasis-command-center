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
import type { InjectedToolset } from "@/lib/cloud-tool-runner";
import { redactAll, redactTenantVaultSecrets, StreamingRedactor, type VaultSecret } from "@/lib/secret-redaction";
import { fetchTenantVaultSecretsForRedaction } from "@/lib/chat-persistence";
import { deskToolLabel, deskToolSupport, type DeskToolName } from "./catalog";
import { loadDepartmentState } from "./state";
import { INJECTION_GUARD } from "@/lib/llm-input-boundary";
import { renderDepartmentState, restrictDepartmentState, type DeskStateFacts, type DeskToolsInfo } from "./state-render";
import { deskToolset } from "./tools";
import type { AutomationProposalPolicy } from "./proposals";
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
  | { type: "tool"; phase: "start" | "done"; label: string; ok: boolean | null; detail?: string | null; size?: number | null }
  /** The model's reasoning summary, where its provider shows one: the activity trail, never the reply. */
  | { type: "thinking"; text: string }
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
  /** Tests inject the workspace vault read (lib/chat-persistence.ts). */
  loadVault?: (tenantId: string) => Promise<VaultSecret[]>;
  /**
   * An automation's limits (lib/automations). `only`: the lookups it may make
   * (./tools.ts: the palette AND execute()). `stateAllow`: the DEPARTMENT STATE
   * sections it may be shown, by the lookup that reads each
   * (./state-render.ts restrictDepartmentState). `proposal`: its draft rules.
   * Absent: a chat turn, the department's whole palette and page.
   */
  only?: readonly DeskToolName[];
  stateAllow?: readonly DeskToolName[];
  proposal?: AutomationProposalPolicy;
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

/**
 * Reply text through lib/secret-redaction.ts StreamingRedactor (env secrets and
 * this workspace's vault values), the same guard the operator chat streams
 * through: a secret split across two deltas is still caught, and whatever the
 * redactor holds back is flushed before any other event.
 */
async function* redactedStream(source: AsyncGenerator<DeskEvent>, vault: VaultSecret[]): AsyncGenerator<DeskEvent> {
  const redactor = new StreamingRedactor(vault);
  for await (const ev of source) {
    if (ev.type === "delta") {
      const safe = redactor.push(ev.text);
      if (safe) yield { type: "delta", text: safe };
      continue;
    }
    // Reasoning and a lookup's result line are scrubbed like the reply: the
    // model reads workspace data, and what it writes about it reaches the browser.
    if (ev.type === "thinking") {
      yield { type: "thinking", text: redactTenantVaultSecrets(redactAll(ev.text), vault) };
      continue;
    }
    const rest = redactor.flush();
    if (rest) yield { type: "delta", text: rest };
    yield ev.type === "error"
      ? { type: "error", message: redactAll(ev.message) }
      : ev.type === "tool" && ev.detail
        ? { ...ev, detail: redactTenantVaultSecrets(redactAll(ev.detail), vault) }
        : ev;
  }
  const tail = redactor.flush();
  if (tail) yield { type: "delta", text: tail };
}

async function* fromLoop(source: AsyncGenerator<StreamYield>): AsyncGenerator<DeskEvent> {
  let text = "";
  for await (const ev of source) {
    if (ev.type === "delta") {
      text += ev.text;
      yield ev;
    } else if (ev.type === "tool_use") {
      yield { type: "tool", phase: "start", label: deskToolLabel(ev.name), ok: null };
    } else if (ev.type === "thinking") {
      yield ev;
    } else if (ev.type === "tool_result") {
      // The result's one-line summary ("Pipeline: 12 leads") is already scrubbed
      // (the toolset wrapper) and names no table or persona: it is the "result
      // size" the trail shows. A refused or failed lookup shows no detail.
      const label = deskToolLabel(ev.name);
      const prefix = `${label}: `;
      const line = ev.summary.startsWith(prefix) ? ev.summary.slice(prefix.length) : ev.summary;
      yield { type: "tool", phase: "done", label, ok: ev.ok, detail: ev.ok && line.trim() ? line.trim().slice(0, 120) : null };
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
  let vault: VaultSecret[];
  try {
    [facts, vault] = await Promise.all([
      (args.loadState ?? loadDepartmentState)(viewer, dept, Date.now(), args.stateAllow ? { allow: args.stateAllow } : {}),
      // COMPLETE or nothing: an entry that cannot be decrypted fails the read,
      // so no summary goes out scrubbed of only some secrets.
      (args.loadVault ?? ((id: string) => fetchTenantVaultSecretsForRedaction(id, { requireComplete: true })))(viewer.surface.tenantId),
    ]);
  } catch (err) {
    // Each read already fails on its own; this is the loader itself breaking,
    // or the vault read that redaction needs: no workspace data goes out
    // unredacted, so the turn goes out with none.
    console.error("[os.desk.state]", { tenantId: turn.tenantId, department: dept.key, error: err instanceof Error ? err.message : String(err) });
    return ungrounded(args, dept, `the ${dept.label} page could not be read this turn`);
  }
  // Workspace data reaches the provider only after the env-secret and the
  // workspace-vault scrubs (lib/secret-redaction.ts), the same pair every
  // other chat path applies: a key pasted into a lead's notes, a ticket or a
  // routine name is replaced before the request is built.
  const scrub = (text: string) => redactTenantVaultSecrets(redactAll(text), vault);
  // Whatever loaded them, an automation's facts are cut to what it may read.
  if (args.stateAllow) facts = restrictDepartmentState(facts, args.stateAllow);

  const toolset = deskToolset({ viewer, dept, agentSlug: turn.agentSlug, planMode, only: args.only, proposal: args.proposal });
  const palette = toolset.palette;
  const info: DeskToolsInfo = support.on ? { on: true, tools: palette } : { on: false, reason: support.reason, tools: palette };
  const system = turn.system + scrub(renderDepartmentState(facts, info));
  const grounded: DeskTurn = { ...turn, system };

  if (!support.on) {
    return {
      system,
      tools: { on: false, labels: [], note: `Looking things up is off: ${support.reason}. Answers use this page's summary only.` },
      stream: (messages) => redactedStream(plain(args, grounded, messages), vault),
    };
  }

  // Every tool result is scrubbed the same way before it joins the request.
  const scrubbedTools: InjectedToolset = {
    tools: toolset.tools,
    execute: async (name, input) => {
      const r = await toolset.execute(name, input);
      return { ...r, content: scrub(r.content), summary: scrub(r.summary) };
    },
  };
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
      const toolset = scrubbedTools;
      let loop: AsyncGenerator<StreamYield>;
      if (turn.provider === "anthropic") {
        loop = streamAnthropicWithTools({ apiKey: turn.apiKey, model: turn.model, system, messages: history, maxTokens: args.maxTokens, meter: turn.meter, toolset }, ctx);
      } else if (turn.provider === "openai" || turn.provider === "openrouter") {
        // GPT-5.x and the o-series spend reasoning tokens against the cap
        // (lib/providers.ts streamOpenAI): the answer keeps its budget.
        const maxTokens = args.maxTokens + (turn.provider === "openai" && openaiReasons(turn.model) ? THINKING_HEADROOM_TOKENS : 0);
        loop = streamOpenAICompatibleWithTools(
          { provider: turn.provider, apiKey: turn.apiKey, model: turn.model, system, messages: history, maxTokens, meter: turn.meter, toolset },
          ctx,
        );
      } else {
        loop = streamGeminiWithTools({ apiKey: turn.apiKey, model: turn.model, system, messages: history, maxTokens: args.maxTokens, meter: turn.meter, toolset });
      }
      // What the model writes back is scrubbed on its way to the browser too.
      return redactedStream(fromLoop(loop), vault);
    },
  };
}
