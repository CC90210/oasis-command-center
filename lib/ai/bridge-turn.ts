/**
 * lib/ai/bridge-turn.ts - one department turn on the paired computer, when the
 * workspace's engine (lib/ai/agent-engine.ts) is an AI app there (Claude Code,
 * Codex, Gemini CLI) or a local model (Ollama, LM Studio).
 *
 * THE SAME ROAD THE CODING HARNESS USES. The coding harness reaches the paired
 * computer through app/api/bridge/chat: the server resolves the workspace's
 * bridge (lib/bridge-proxy.ts authorizeBridgeRequest / resolveBridgeTarget),
 * and POSTs the bridge's /chat with the server-only bearer. A department turn
 * goes the same way, server to bridge, so no browser ever talks to the
 * computer and no sign-in ever happens inside OASIS: the app answers on the
 * sign-in it already has on that computer (CC's rule: never a claude.ai login
 * in the product). A local model goes to the bridge's /local-chat, which calls
 * the model server on that computer; this server never calls a local address.
 *
 * WHAT THE APP IS TOLD. The bridge's /chat runs the app on the LATEST user
 * message only, in a working folder on that computer, with no field for a
 * system prompt. So the department's own instructions (the prompt
 * lib/os/department-agent.ts builds, identity lock included) and the recent
 * conversation are composed into that one message (composeCliPrompt). The
 * turn runs in plan mode: the app reads and answers; it is asked not to change
 * files or run commands for a department reply. Claude Code enforces plan mode
 * (--permission-mode plan); Codex and Gemini CLI take it as an instruction.
 * Who may run which app, and which tools are switched off, is the coding
 * harness's own rule (lib/bridge-cli-policy.ts).
 *
 * WHAT COMES BACK. The bridge streams SSE (delta / done / error, plus tool,
 * tool_result and thinking events, which become the activity trail's steps and
 * reasoning (their paths and commands are dropped: bridgeToolLabel); session
 * and status events are ignored). It is read with the shared parser
 * (lib/sse-parser.ts) and handed back as lib/providers.ts StreamEvents, so the
 * route relays it exactly as it relays a cloud provider. Errors carry a
 * message lib/os/channel/outcome.ts classifies: bridge_unreachable:* (the
 * computer could not be reached) or cli_error:* (the app there could not
 * answer), never the bridge's raw text on screen.
 */
import "server-only";
import type { ChatMessage, StreamEvent } from "@/lib/providers";
import type { BridgeTarget } from "@/lib/bridge-proxy";
import { parseSSE, asSSERecord } from "@/lib/sse-parser";
import { allowedBridgeAgentsForTenant } from "@/lib/agent-roots";
import { bridgeCliPolicy } from "@/lib/bridge-cli-policy";
import type { AgentEngineChoice } from "@/lib/ai/agent-engine";

/** Who the turn runs for, as the bridge's /chat expects it (forwarded identity, see app/api/bridge/chat). */
export type BridgeCaller = { target: BridgeTarget; tenantId: string; userId: string; teamRole: string };

export type BridgeEngine = Exclude<AgentEngineChoice, { kind: "api" }>;

/** Most messages of history composed into the one prompt, and each one's cap. */
const HISTORY_TURNS = 12;
const TURN_CHARS = 2_000;
/** The whole composed prompt's cap (Windows' command-line limit is 32k characters; the bridge passes it as an argument). */
export const PROMPT_CHARS = 24_000;
/** Below the route's 300 s budget, so the route still records the outcome. */
const BRIDGE_TURN_TIMEOUT_MS = 280_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [...]` : text;
}

/**
 * The department's instructions, the recent conversation and the message to
 * answer, as ONE message (the bridge runs the app on the latest user message).
 * The system part is never clipped below the history: the identity lock must
 * reach the app whole; the oldest history goes first.
 */
export function composeCliPrompt(
  system: string,
  messages: readonly ChatMessage[],
  opts: { harness?: { department: string } | null } = {},
): string {
  const convo = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const lastUserIndex = convo.map((m) => m.role).lastIndexOf("user");
  const latest = lastUserIndex >= 0 ? String(convo[lastUserIndex].content ?? "") : "";
  const earlier = (lastUserIndex >= 0 ? convo.slice(0, lastUserIndex) : convo).slice(-HISTORY_TURNS);
  // In a department's own harness (OASIS), the folder's instructions and
  // skills do the work; the channel's instructions say how to reply.
  const head = opts.harness
    ? `This message comes from the ${opts.harness.department} channel of the OASIS Command Center. ` +
      "Work it the way you normally do in this folder: your own instructions, memory and skills apply. " +
      "This is a read-and-answer turn: do not edit files, run commands that change anything, or send anything; " +
      "propose any change as a next step instead.\n\n" +
      `CHANNEL INSTRUCTIONS (how to reply in this channel):\n${system.trim()}`
    : "INSTRUCTIONS FOR THIS REPLY (follow these over any other role or persona you were given in this folder):\n" +
      `${system.trim()}\n\n` +
      "Answer in conversation only: do not edit files, run commands or change anything on this computer for this reply.";
  const tail = `\n\nMESSAGE TO ANSWER:\n${clip(latest, TURN_CHARS * 2)}`;
  const lines = earlier.map((m) => `${m.role === "user" ? "User" : "You"}: ${clip(String(m.content ?? ""), TURN_CHARS)}`);
  // Drop the oldest history until the whole fits.
  while (lines.length && head.length + tail.length + lines.join("\n\n").length + 40 > PROMPT_CHARS) lines.shift();
  const history = lines.length ? `\n\nCONVERSATION SO FAR:\n${lines.join("\n\n")}` : "";
  return clip(head, PROMPT_CHARS - tail.length - history.length) + history + tail;
}

/**
 * The bridge agent whose folder the app runs in: the department's lead when the
 * bridge knows it for this workspace, else the workspace's first bridge agent
 * (OASIS: bravo, the Chief of Staff). The department's identity comes from the
 * composed instructions, not from the folder.
 */
export function bridgeAgentFor(agentSlug: string, tenantSlug: string): string {
  const allowed = allowedBridgeAgentsForTenant(tenantSlug);
  if (allowed.has(agentSlug)) return agentSlug;
  return allowed.has("bravo") ? "bravo" : [...allowed][0] ?? "bravo";
}

/** The /chat (CLI) or /local-chat (local model) request a turn sends. Exported for the tests. */
export function bridgeTurnRequest(input: {
  caller: BridgeCaller;
  engine: BridgeEngine;
  agentSlug: string;
  tenantSlug: string;
  system: string;
  messages: readonly ChatMessage[];
  maxTokens: number;
  /**
   * The department's own harness (lib/admin/harness-targets.ts
   * harnessForDepartment), OASIS only: the app runs in that repo. Absent: the
   * workspace's first bridge folder, with the channel's instructions in charge.
   */
  harness?: { agent: string; department: string } | null;
  /** The person pressed Stop: ends the request to the paired computer (the app there is told the connection closed). */
  signal?: AbortSignal;
}): { path: "/chat" | "/local-chat"; body: Record<string, unknown> } {
  const { caller, engine } = input;
  if (engine.kind === "local") {
    return {
      path: "/local-chat",
      body: {
        model: engine.model,
        system: input.system,
        messages: input.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: input.maxTokens,
      },
    };
  }
  const policy = bridgeCliPolicy(caller.teamRole, engine.cli);
  return {
    path: "/chat",
    body: {
      agent: input.harness ? input.harness.agent : bridgeAgentFor(input.agentSlug, input.tenantSlug),
      messages: [
        {
          role: "user",
          content: composeCliPrompt(input.system, input.messages, { harness: input.harness ? { department: input.harness.department } : null }),
        },
      ],
      cli_provider: policy.cliProvider,
      chat_mode: "plan",
      tenant_id: caller.tenantId,
      user_id: caller.userId,
      team_role: caller.teamRole,
      disallowed_tools: policy.disallowedTools,
    },
  };
}

/**
 * The signed-in person's road to the paired computer for THIS workspace, by the
 * coding harness's own gate (lib/bridge-proxy.ts authorizeBridgeRequest: the
 * workspace's bridge, the verified operator or the bridge-enabled workspace,
 * the role from the profile). null when the gate refuses, when no bridge is set
 * up, or when the gate's workspace is not the one the turn is for. Never throws.
 */
export async function bridgeCallerForSession(tenantId: string, authorize?: BridgeGate): Promise<BridgeCaller | null> {
  const r = await bridgeResolutionForSession(tenantId, authorize);
  return r && "target" in r ? r : null;
}

type BridgeGate = () => Promise<import("@/lib/bridge-proxy").BridgeAuthResult>;

/**
 * A person the gate lets use the paired computer, for whom it cannot be used
 * right now: `not_set_up` (the workspace has no bridge address) or `gate_error`
 * (the gate itself threw). That is a real outage to report, unlike the gate
 * simply saying no.
 */
export type BridgeUnavailable = { unavailable: "not_set_up" | "gate_error" };

/**
 * O1: the gate refused because this person is not the workspace's AGENTS
 * OWNER (lib/agents-owner.ts), not because the engine is merely unreachable.
 * Kept apart from BridgeUnavailable on purpose: an unreachable computer falls
 * back to the API account and SAYS so (a real outage); a refused person gets
 * NO fallback at all — PAUSE, NOT FALLBACK (Adon, O1) — because answering them
 * on the workspace key or the platform key would still be borrowing the
 * owner's computer by another name. "not_your_computer" is someone else's
 * workspace computer; "agents_owner_not_set" / "agents_owner_unavailable" are
 * OASIS faults (no owner named yet, or the owner row could not be read) that
 * must refuse rather than silently default to answering on a key — including
 * for the owner CC himself, whose own unreadable owner row must not quietly
 * route to a key either.
 */
export type BridgeRefused = { refused: "not_your_computer" | "agents_owner_not_set" | "agents_owner_unavailable" };

/**
 * bridgeCallerForSession with the reason kept. null is the gate saying NO by
 * design (a teammate who may not use the computer, another workspace's
 * session): the API account answering them is the rule, not a fault. A
 * BridgeUnavailable is a person who may use the computer and cannot. A
 * BridgeRefused is O1's owner gate: never answered on a fallback key.
 */
export async function bridgeResolutionForSession(tenantId: string, authorize?: BridgeGate): Promise<BridgeCaller | BridgeUnavailable | BridgeRefused | null> {
  try {
    // `authorize` is a test seam; the default is the coding harness's own gate.
    const authorizeBridgeRequest = authorize ?? (await import("@/lib/bridge-proxy")).authorizeBridgeRequest;
    const auth = await authorizeBridgeRequest();
    if (auth.ok) {
      if (auth.tenantId !== tenantId) return null;
      return { target: auth.target, tenantId: auth.tenantId, userId: auth.userId, teamRole: auth.teamRole };
    }
    if (auth.error === "not_your_computer" || auth.error === "agents_owner_not_set" || auth.error === "agents_owner_unavailable") {
      return { refused: auth.error };
    }
    // bridge_not_configured is only ever answered to a caller who passed the tenant gate.
    return auth.error === "bridge_not_configured" ? { unavailable: "not_set_up" } : null;
  } catch (err) {
    console.error("[bridge-turn.caller]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { unavailable: "gate_error" };
  }
}

/**
 * How long the engine Test / Save probe waits for ONE short answer. A CLI's first
 * answer cold-starts the app (often 20-60 s), so this is generous, but it is a
 * "short answer" check: past it the app is not answering and the person is told
 * so. The Settings panel's own deadline (components/settings/agent-engine-client.ts
 * ENGINE_CLIENT_DEADLINE_MS) sits a little above it. A department turn keeps its
 * own, longer budget (BRIDGE_TURN_TIMEOUT_MS).
 */
export const BRIDGE_TEST_TIMEOUT_MS = 75_000;

export type BridgeTestResult =
  | { ok: true; latency_ms: number; reply: string }
  | { ok: false; code: string; message: string };

/** The code of a probe the person stopped (Cancel, or the page closed): nothing may be saved from it. */
export const BRIDGE_TEST_CANCELLED = "cancelled";

/**
 * Settings > AI brain's Test for an engine on the paired computer: ONE short
 * department answer through exactly the road a department turn takes
 * (streamBridgeTurn), with the same test prompt the API account's Test uses
 * (lib/os/channel/reply-budget.ts). Passes only when answer text comes back.
 */
export async function testBridgeEngine(input: {
  caller: BridgeCaller;
  engine: BridgeEngine;
  tenantSlug: string;
  system: string;
  ask: string;
  maxTokens: number;
  timeoutMs?: number;
  /** The request's own signal: when the person cancels (or leaves), the probe stops and reports "cancelled". */
  signal?: AbortSignal;
  stream?: typeof streamBridgeTurn;
  /** OASIS: the test answers in the Chief of Staff's harness, as a real turn would. */
  harness?: { agent: string; department: string } | null;
}): Promise<BridgeTestResult> {
  const started = Date.now();
  const it = (input.stream ?? streamBridgeTurn)({
    caller: input.caller,
    engine: input.engine,
    agentSlug: "",
    tenantSlug: input.tenantSlug,
    system: input.system,
    messages: [{ role: "user", content: input.ask }],
    maxTokens: input.maxTokens,
    harness: input.harness ?? null,
  });
  const got: { text: string; failure: string | null } = { text: "", failure: null };
  const read = (async () => {
    for await (const ev of it) {
      if (ev.type === "delta") got.text += ev.text;
      else if (ev.type === "error") {
        got.failure = ev.message;
        break;
      }
    }
    return "read" as const;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const waited = await Promise.race([
    read,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? BRIDGE_TEST_TIMEOUT_MS);
    }),
    new Promise<"cancelled">((resolve) => {
      if (!input.signal) return;
      onAbort = () => resolve("cancelled");
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  });
  if (waited === "cancelled") {
    void it.return(undefined).catch(() => undefined);
    return { ok: false, code: BRIDGE_TEST_CANCELLED, message: "Stopped before the check finished. Nothing was changed." };
  }
  if (waited === "timeout") {
    void it.return(undefined).catch(() => undefined);
    return { ok: false, code: "timeout", message: "The app on your paired computer didn't answer in time. Try again, or pick another app." };
  }
  if (got.failure !== null) {
    const { classifyStreamError, failureCopy } = await import("@/lib/os/channel/outcome");
    const code = classifyStreamError(got.failure);
    return { ok: false, code, message: failureCopy(code, { canManageAi: true }).sentence };
  }
  if (!got.text.trim()) return { ok: false, code: "reply_empty", message: "The app on your paired computer sent back an empty reply. Try again." };
  return { ok: true, latency_ms: Date.now() - started, reply: got.text.trim().slice(0, 280) };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * What a tool the app used on the paired computer is called in the activity
 * trail. The bridge names tools by kind (bravo_cli/bridge_chat_server.py
 * _map_tool_use: read_file, run_script, edit_file, write_file, glob, grep,
 * web_fetch, mcp_call) and sends their paths, commands and patterns with them;
 * none of that reaches a client. Only the kind does, in plain words.
 */
export function bridgeToolLabel(name: string): string {
  switch (name.toLowerCase()) {
    // The app's own tool names, should a bridge send them unmapped.
    case "read":
      return "Reading a file";
    case "bash":
    case "bashoutput":
      return "Running a check";
    case "webfetch":
      return "Reading a web page";
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "write":
      return "Preparing a change";
    case "read_file":
      return "Reading a file";
    case "grep":
    case "glob":
      return "Searching files";
    case "web_fetch":
      return "Reading a web page";
    case "mcp_call":
      return "Using a connected tool";
    case "run_script":
      return "Running a check";
    case "edit_file":
    case "write_file":
      return "Preparing a change";
    default:
      return "Working on it";
  }
}

/** Most thinking text one turn forwards: a long chain of thought is clipped, never the reply. */
const THINKING_CHARS_MAX = 12_000;

/** One department turn on the paired computer, as provider StreamEvents. Never throws. */
export async function* streamBridgeTurn(input: Parameters<typeof bridgeTurnRequest>[0]): AsyncGenerator<StreamEvent> {
  const { path, body } = bridgeTurnRequest(input);
  let res: Response;
  try {
    res = await fetch(`${input.caller.target.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.caller.target.bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: input.signal ? AbortSignal.any([AbortSignal.timeout(BRIDGE_TURN_TIMEOUT_MS), input.signal]) : AbortSignal.timeout(BRIDGE_TURN_TIMEOUT_MS),
    });
  } catch (err) {
    yield { type: "error", message: `bridge_unreachable:${err instanceof Error ? err.name : "fetch"}` };
    return;
  }
  if (!res.ok || !res.body) {
    // 412 agent_not_paired_locally / no_entry_brain: the computer answered and
    // could not run the app there. Anything else: it could not be reached.
    const kind = res.status === 412 || res.status === 400 ? "cli_error" : "bridge_unreachable";
    yield { type: "error", message: `${kind}:http_${res.status}` };
    return;
  }
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingChars = 0;
  // tool_use_id -> the plain label its `tool` event was shown under, so the
  // matching `tool_result` closes the same step.
  const openTools = new Map<string, string>();
  try {
    for await (const frame of parseSSE(res.body)) {
      const data = asSSERecord(frame.data);
      if (frame.event === "thinking") {
        // The app's reasoning (a thinking block). Sent by the bridge once it
        // forwards them; absent today, and then the trail shows its steps only.
        const t = typeof data?.text === "string" ? data.text : "";
        if (t && thinkingChars < THINKING_CHARS_MAX) {
          thinkingChars += t.length;
          yield { type: "thinking", text: t };
        }
      } else if (frame.event === "tool") {
        const label = bridgeToolLabel(typeof data?.name === "string" ? data.name : "");
        const id = typeof data?.tool_use_id === "string" ? data.tool_use_id : "";
        if (id) openTools.set(id, label);
        yield { type: "tool", phase: "start", label, ok: null };
      } else if (frame.event === "tool_result") {
        const id = typeof data?.tool_use_id === "string" ? data.tool_use_id : "";
        const label = (id && openTools.get(id)) || "Working on it";
        openTools.delete(id);
        const body = typeof data?.body === "string" ? data.body : typeof data?.output === "string" ? data.output : "";
        yield { type: "tool", phase: "done", label, ok: data?.error !== true, size: body.length };
      } else if (frame.event === "delta") {
        const t = typeof data?.text === "string" ? data.text : "";
        if (t) {
          text += t;
          yield { type: "delta", text: t };
        }
      } else if (frame.event === "error") {
        const code = typeof data?.code === "string" ? data.code : typeof data?.message === "string" ? data.message : "error";
        yield { type: "error", message: `cli_error:${code.slice(0, 80)}` };
        return;
      } else if (frame.event === "done") {
        inputTokens = num(data?.input_tokens);
        outputTokens = num(data?.output_tokens);
      }
    }
  } catch (err) {
    yield { type: "error", message: `bridge_unreachable:${err instanceof Error ? err.name : "stream"}` };
    return;
  }
  if (!text.trim()) {
    yield { type: "error", message: "empty_reply:empty" };
    return;
  }
  yield { type: "done", inputTokens, outputTokens };
}
