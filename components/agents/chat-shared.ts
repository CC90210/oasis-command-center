/**
 * components/agents/chat-shared.ts - what the two channel components share:
 * components/agents/AgentChat.tsx (a direct agent chat, and the shell that
 * hands a department channel to DepartmentChat) and
 * components/agents/DepartmentChat.tsx (a department channel, whose messages
 * are saved runs).
 *
 * Moved out of AgentChat.tsx unchanged so neither imports the other; AgentChat
 * re-exports them, so every existing import keeps working. PURE.
 */
import { COMMAND_DESCRIPTIONS, type SlashCommandName } from "@/lib/chat-modes/slash-parser";
import { failureCopy, type FailureModel } from "@/lib/os/channel/outcome";
import { isEngineSpend, spendTag } from "@/lib/ai/agent-engine";

/** The "via" footer of an answer, from the route's `agent` event: what ran it and whose credits it spent. */
export function viaLine(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { runs_on?: unknown; spend?: unknown; model?: unknown; fell_back_from?: unknown; engine_not_used?: unknown };
  const what = typeof p.runs_on === "string" && p.runs_on.trim() ? p.runs_on.trim() : typeof p.model === "string" && p.model ? p.model : null;
  if (!what) return null;
  const parts = [what];
  if (isEngineSpend(p.spend)) parts.push(spendTag(p.spend));
  if (typeof p.fell_back_from === "string" && p.fell_back_from) parts.push(`${p.fell_back_from} could not be reached`);
  // The API account answers by design here: say so, never "could not be reached".
  else if (typeof p.engine_not_used === "string" && p.engine_not_used) parts.push(`${p.engine_not_used} is not used for this chat`);
  return parts.join(" - ");
}

/** The `model` of a route error event (app/api/agents/chat), when it is well formed. */
export function asFailureModel(raw: unknown): FailureModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.label !== "string" || !m.label.trim()) return null;
  return {
    label: m.label,
    vendor: typeof m.vendor === "string" ? m.vendor : null,
    suggestion: typeof m.suggestion === "string" ? m.suggestion : null,
  };
}

// sessionStorage key for plan mode. Per-tab so a tenant-preview reload
// doesn't drop the operator back into build mode mid-investigation.
// Distinct from ChatWidget's key — separate surfaces, separate state.
export const PLAN_MODE_STORAGE_KEY = "oasis.tenant-chat.planMode.v1";

/**
 * The commands that work in this chat. /agent and /model belong to the
 * operator chat: a channel's agent is fixed, and its model is a setting.
 * /compact summarises through /api/chat/compact, which answers on the caller's
 * OWN config for the agent key (a teammate's personal key first) and has no row
 * for most department agents, so in a department channel it would fail, or
 * send the shared channel's transcript to one person's key. A department
 * channel does not offer it.
 */
export function chatCommands(department: string | undefined): SlashCommandName[] {
  return department ? ["clear", "plan", "build", "help"] : ["clear", "compact", "plan", "build", "help"];
}

export function chatHelp(department: string | undefined): string {
  return ["Slash commands:", ...chatCommands(department).map((c) => `  ${COMMAND_DESCRIPTIONS[c]}`)].join("\n");
}

/** What a command this chat does not offer answers with, instead of running. */
export function unavailableCommandCopy(name: SlashCommandName): string {
  if (name === "agent") return "/agent isn't available here. Each department has its own channel.";
  if (name === "model") return "/model isn't available here. The AI model is chosen in Settings > AI brain.";
  if (name === "compact") return "/compact isn't available in a department channel. Use /clear to start a fresh conversation.";
  return `/${name} isn't available here.`;
}

/** The sentences for what the run routes can refuse with, in addition to a turn's own failure codes (outcome.ts failureCopy). */
const RUN_ROUTE_COPY: Record<string, string> = {
  queue_full: "Too many messages are waiting. Let one finish, or stop one, then send again.",
  message_too_long: "That message is too long to send. Shorten it and try again.",
  chat_history_unavailable: "Saved chats aren't available right now, so that message was not sent. Try again in a minute.",
  conversation_not_found: "That chat no longer exists. Start a new one.",
  run_not_found: "That message is no longer there.",
  interrupted: "This reply was interrupted before it finished. Send it again to retry.",
  send_failed: "That message could not be sent. Try again.",
};

/** One plain sentence for any code a run or a run route can end with. */
export function runFailureSentence(code: string, opts: { canManageAi: boolean; model?: FailureModel | null }): string {
  return RUN_ROUTE_COPY[code] ?? failureCopy(code, opts).sentence;
}

/**
 * O4: the deferred status line for a run dispatched to this person's own
 * paired computer (lib/os/runs/computer-turn.ts), while it hasn't answered
 * yet. `label` is the computer's own name (set by whoever paired it,
 * run-store.ts DeptChatState.computerLabel, learned from the SSE prelude's
 * `computer_label`); unknown only on a reopened chat this browser did not
 * send into, so it falls back to a plain "your computer". `engine` is the app
 * the run was queued to run on ("Codex", lib/os/runs/engine-label.ts); unknown,
 * the running line says only that the computer is answering, never a guessed
 * app. `busy` is whether
 * another message in this SAME conversation is already running (the
 * computer can only answer one at a time): that is the one case the
 * question "why hasn't it answered" has a better sentence than "waiting".
 * Null for every run not dispatched this way — a worker-driven run keeps
 * its ordinary "Queued - goes next" / activity-trail copy, and this line
 * never names a house agent.
 */
export function computerStatusLine(args: { executor: string | null; status: string; label: string | null; busy: boolean; engine?: string | null }): string | null {
  if (args.executor !== "computer") return null;
  if (args.status === "queued") {
    return args.busy ? `${args.label || "Your computer"} is busy with another reply` : `Waiting for ${args.label || "your computer"} to pick this up`;
  }
  if (args.status === "running") {
    const engine = args.engine?.trim();
    return engine ? `${args.label || "Your computer"} · ${engine}` : `${args.label || "Your computer"} is answering`;
  }
  return null;
}
