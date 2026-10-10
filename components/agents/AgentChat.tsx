"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { parseInput } from "@/lib/chat-modes/slash-parser";
import { usePlanMode } from "@/lib/chat-modes/use-plan-mode";
import { failureCopy, isTurnFailureCode, type FailureModel } from "@/lib/os/channel/outcome";
import { announceTurn } from "@/components/os/department/turn-event";
import { deskToolsNote } from "@/lib/os/desk/catalog";
import type { EngineLabel } from "@/lib/ai/agent-engine";
import { CHAT_LIST_CLASS, CHAT_VIA_CLASS, chatBubbleClass, chatRowClass } from "./chat-layout";
import {
  PLAN_MODE_STORAGE_KEY,
  asFailureModel,
  chatCommands,
  chatHelp,
  unavailableCommandCopy,
  viaLine,
} from "./chat-shared";
import { ChannelHeader } from "./ChannelHeader";
import { DepartmentChat } from "./DepartmentChat";

// These lived here before the department channel moved to DepartmentChat; the
// tests and any other import keep resolving them from this file.
export { chatCommands, chatHelp, unavailableCommandCopy, viaLine };

type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  /** Which model+provider serviced this assistant turn. Captured from
   *  the `agent` SSE event the server emits right before streaming
   *  text. Surfaces as a "via X" pill under the message so the operator
   *  can verify which runtime actually answered. The server sends the
   *  model to the verified operator only, so clients never see it. */
  runtime?: string;
};

export type ChannelProps = {
  /** A workspace slug the viewer owns (the /t/<slug> preview). Omitted by a
   *  department channel: the route takes the workspace from the session. */
  tenantSlug?: string;
  agentSlug: string;
  agentName: string;
  agentSubtitle?: string;
  /** Optional welcome message rendered above the empty-state. */
  greeting?: string;
  /** Set by a department channel; the route answers as that department. */
  department?: string;
  /** Owners/admins: failures carry a link to AI settings. Others are told
   *  who can fix it, because the link would 404 for them. */
  canManageAi?: boolean;
  /** The channel's last recorded turn failed with this code: say so before
   *  the next message is typed. */
  initialFailure?: string | null;
  /**
   * What answers in this channel, in Settings > AI brain's own words
   * ("Google Gemini, Gemini 3.8 Flash", or "Claude Code on your paired
   * computer", lib/ai/agent-engine.ts) and whose credits it spends, linking to
   * that choice. Set by a department channel for owners and admins.
   */
  poweredBy?: EngineLabel | null;
};

/**
 * A department channel (a `department` is set) is DepartmentChat: its messages
 * are saved runs that outlive the page. Anything else (the /t/<slug> agent
 * preview, the /agents page) is a direct agent chat that streams the reply to
 * this page, below.
 */
export function AgentChat(props: ChannelProps) {
  return props.department ? <DepartmentChat {...props} department={props.department} /> : <DirectAgentChat {...props} />;
}

function DirectAgentChat({
  tenantSlug,
  agentSlug,
  agentName,
  agentSubtitle,
  greeting,
  department,
  canManageAi = false,
  initialFailure = null,
  poweredBy = null,
}: ChannelProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // A failure is a CODE (lib/os/channel/outcome.ts), rendered as one plain
  // sentence with a fix link. Raw provider text never reaches the screen.
  const [failure, setFailure] = useState<string | null>(initialFailure);
  // The model a "not found" was about, as the route named it (its error event).
  const [failureModel, setFailureModel] = useState<FailureModel | null>(null);
  // A department turn's lookups (app/api/agents/chat `tool` events) and, when
  // lookups are off for this AI account, why (the `agent` event's `tools`).
  const [toolsNote, setToolsNote] = useState<string | null>(null);
  const [lookups, setLookups] = useState<string[]>([]);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  // Plan vs Build — OpenCode-style state machine. /plan filters write
  // intent out of the agent's system prompt (server-side, see
  // app/api/agents/chat/route.ts); /build restores full behavior.
  // The shared usePlanMode hook owns sessionStorage hydration +
  // persistence; the per-surface key keeps this state isolated from
  // the operator's ChatWidget.
  const [planMode, setPlanMode] = usePlanMode(PLAN_MODE_STORAGE_KEY);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, streaming]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setFailure(null);
      setFailureModel(null);
      setLookups([]);

      // Slash commands — intercepted client-side, never hit the server.
      // Scoped to the commands this chat offers (chatCommands): anything
      // else says why it is not here instead of running.
      const parsed = parseInput(trimmed);
      if (parsed.kind === "command") {
        const appendSystem = (content: string) =>
          setTurns((prev) => [...prev, { role: "system", content }]);
        if (!chatCommands(department).includes(parsed.name)) {
          appendSystem(unavailableCommandCopy(parsed.name));
          setInput("");
          return;
        }
        switch (parsed.name) {
          case "clear":
            setTurns([]);
            setInput("");
            return;
          case "help":
            appendSystem(chatHelp(department));
            setInput("");
            return;
          case "plan":
            setPlanMode("plan");
            appendSystem(
              "Plan mode active — agent reads + reasons but write tools are gated server-side. Hit /build (or the Execute toggle) when you're ready to run.",
            );
            setInput("");
            return;
          case "build":
            setPlanMode("build");
            appendSystem("Execute mode active — full agent capabilities restored.");
            setInput("");
            return;
          case "compact": {
            const focusHint = parsed.args.trim();
            const hasAssistant = turns.some((t) => t.role === "assistant");
            const userCount = turns.filter((t) => t.role === "user").length;
            if (!hasAssistant || userCount < 1) {
              appendSystem("Nothing to compact yet — send a few turns first.");
              setInput("");
              return;
            }
            setInput("");
            void (async () => {
              appendSystem("Compacting conversation…");
              try {
                // Reuses the main /api/chat/compact endpoint — the
                // manifest-aware isTenantChatAgent check accepts the
                // marketplace agent's slug, and the compaction system
                // prompt is agent-agnostic ("summarize this transcript
                // in one paragraph"). Same path, same UX.
                const res = await fetch("/api/chat/compact", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    agent_key: agentSlug,
                    messages: turns.filter(
                      (t) => t.role === "user" || t.role === "assistant",
                    ),
                    focus: focusHint || null,
                  }),
                });
                const body = (await res.json().catch(() => ({}))) as {
                  ok?: boolean;
                  summary?: string;
                };
                if (!res.ok || !body.ok || !body.summary) {
                  appendSystem("Compact failed. History unchanged.");
                  return;
                }
                setTurns([
                  {
                    role: "assistant",
                    content: `--- Context summary ---\n\n${body.summary.trim()}\n\n--- End summary ---`,
                  },
                ]);
              } catch (err) {
                console.error("[agent-chat.compact]", err);
                appendSystem("Compact failed. History unchanged.");
              }
            })();
            return;
          }
        }
      }

      const nextTurns: ChatTurn[] = [
        ...turns,
        { role: "user", content: trimmed },
        { role: "assistant", content: "" }, // placeholder for streaming
      ];
      setTurns(nextTurns);
      setInput("");
      setStreaming(true);

      // The assistant placeholder goes when no reply text arrived: a failed
      // turn shows its reason under the conversation, not an empty bubble.
      const dropEmptyPlaceholder = () =>
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          return last && last.role === "assistant" && !last.content ? prev.slice(0, -1) : prev;
        });

      try {
        const res = await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
            agent_slug: agentSlug,
            ...(department ? { department } : {}),
            // Filter out system pills — those are client-only chrome
            // (slash-command echoes, error banners) and would confuse
            // the model if sent as conversation history.
            messages: nextTurns
              .slice(0, -1)
              .filter((t) => (t.role === "user" || t.role === "assistant") && (t.content || t.role === "user")),
            // Plan vs build (2026-05-22 parity with ChatWidget). Server
            // composes the plan overlay onto the agent's system prompt
            // when this is "plan".
            chat_mode: planMode,
          }),
        });

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setFailure(body.error || `http_${res.status}`);
          dropEmptyPlaceholder();
          // A refusal that is a verdict on the channel (no account, the month's
          // budget) redraws the department header; a route hiccup does not.
          if (department && isTurnFailureCode(body.error)) announceTurn({ department, ok: false, code: body.error });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";
        let streamFailure: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by blank lines.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            if (!frame.trim()) continue;
            const lines = frame.split("\n");
            let eventName = "message";
            let dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            let payload: unknown;
            try {
              payload = JSON.parse(dataStr);
            } catch {
              continue;
            }
            if (eventName === "agent" && payload && typeof payload === "object") {
              setToolsNote(deskToolsNote((payload as { tools?: unknown }).tools));
              const model = (payload as { model?: string }).model || null;
              setModelLabel(model);
              // Stamp the assistant placeholder with what ran it (and whose
              // credits it spent) so the line renders under the message once
              // streaming completes. The server emits this `agent` event
              // BEFORE any delta, so the placeholder is already on screen.
              const via = viaLine(payload);
              if (via) {
                setTurns((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (last && last.role === "assistant") {
                    next[next.length - 1] = { ...last, runtime: via };
                  }
                  return next;
                });
              }
            } else if (eventName === "delta" && payload && typeof payload === "object") {
              const text = (payload as { text?: string }).text || "";
              if (text) {
                assistantText += text;
                setTurns((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  // Preserve the runtime stamp from the prior `agent`
                  // event when patching content during streaming.
                  next[next.length - 1] = {
                    role: "assistant",
                    content: assistantText,
                    runtime: last?.runtime,
                  };
                  return next;
                });
              }
            } else if (eventName === "error" && payload && typeof payload === "object") {
              streamFailure = (payload as { code?: string }).code || "provider_error";
              setFailureModel(asFailureModel((payload as { model?: unknown }).model));
              setFailure(streamFailure);
            } else if (eventName === "tool" && payload && typeof payload === "object") {
              const label = (payload as { label?: unknown; phase?: unknown }).label;
              if ((payload as { phase?: unknown }).phase === "start" && typeof label === "string" && label) {
                setLookups((prev) => (prev.includes(label) ? prev : [...prev, label]));
              }
            }
          }
        }
        if (!assistantText) {
          dropEmptyPlaceholder();
          // A stream that closed with no text and no reason is still a turn
          // that did not answer; say so rather than leave nothing.
          if (!streamFailure) setFailure("empty_reply");
        }
        // The department header shows this turn, as the route recorded it: a
        // reply clears an old failure, a failure says why (turn-event.ts).
        if (department) {
          if (streamFailure) announceTurn({ department, ok: false, code: streamFailure });
          else if (assistantText.trim()) announceTurn({ department, ok: true });
        }
      } catch (err) {
        console.error("[agent-chat.send]", err);
        setFailure("network");
        dropEmptyPlaceholder();
      } finally {
        setStreaming(false);
        inputRef.current?.focus();
      }
    },
    // planMode is read on send (chat_mode payload); setPlanMode is
    // called by the /plan and /build slash commands inside this same
    // callback. Both belong in the dep array per
    // react-hooks/exhaustive-deps. setPlanMode is stable (returned
    // from usePlanMode) so adding it is free.
    [tenantSlug, agentSlug, department, streaming, turns, planMode, setPlanMode]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  // Enter sends, Shift+Enter adds a line — the same as Today's Ask composer
  // (components/os/today/AskComposer.tsx), so a message typed there and
  // handed over here behaves the same way. isComposing: Enter that confirms
  // an IME candidate is not a send.
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const failureText = failure ? failureCopy(failure, { canManageAi, model: failureModel }) : null;

  // Min-height: on phones a hardcoded 640px is taller than a lot of
  // viewports (iPhone SE = 667px). Use a viewport-relative floor on
  // mobile, the original fixed floor on desktop.
  return (
    <div className="flex flex-col rounded-2xl border border-bg-border bg-bg-elev/40 backdrop-blur-sm min-h-[calc(100dvh-14rem)] md:min-h-[640px]">
      <ChannelHeader
        agentName={agentName}
        agentSubtitle={agentSubtitle}
        planMode={planMode}
        onExitPlan={() => {
          setPlanMode("build");
          setTurns((prev) => [
            ...prev,
            { role: "system", content: "Execute mode active — full agent capabilities restored." },
          ]);
        }}
        poweredBy={poweredBy}
        modelLabel={modelLabel}
        canManageAi={canManageAi}
      />

      {toolsNote && (
        <div className="border-b border-bg-border px-5 py-2 text-[11px] text-fg-dim">{toolsNote}</div>
      )}

      {poweredBy?.note && (
        <p className="border-b border-hairline px-5 py-2 text-[11px] leading-snug text-status-warm">{poweredBy.note}</p>
      )}

      {/* Layout: components/agents/chat-layout.ts (bubbles sized to their
          text, yours right and the department's left, the "via" line under
          its bubble). */}
      <div ref={scrollRef} className={CHAT_LIST_CLASS}>
        {turns.length === 0 && (
          <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-3 text-sm text-fg-muted leading-[1.65]">
            {greeting || `Start chatting with ${agentName}. Press Enter to send.`}
          </div>
        )}
        {turns.map((t, i) => {
          // System pills (slash command echoes, mode-change confirmations)
          // get a distinct dimmed style so the operator can scan past them
          // without confusing them for assistant output.
          if (t.role === "system") {
            return (
              <div key={i} className={chatRowClass("system")}>
                <div className={chatBubbleClass("system")}>{t.content}</div>
              </div>
            );
          }
          const isLastAssistant = i === turns.length - 1 && t.role === "assistant";
          const showRuntime =
            t.role === "assistant" &&
            !!t.runtime &&
            t.content.trim().length > 0 &&
            !(streaming && isLastAssistant);
          return (
            <div key={i} className={chatRowClass(t.role)}>
              <div className={chatBubbleClass(t.role)}>
                {t.content || (streaming && i === turns.length - 1 ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent inline" />
                ) : null)}
              </div>
              {showRuntime && <div className={CHAT_VIA_CLASS}>via {t.runtime}</div>}
            </div>
          );
        })}
      </div>

      {lookups.length > 0 && (
        <div className="mx-5 mb-2 text-[11px] text-fg-dim">Looked up: {lookups.join(", ")}</div>
      )}

      {failureText && (
        <div
          role="alert"
          className="mx-5 mb-2 rounded-xl border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-xs text-status-hot inline-flex flex-wrap items-start gap-x-2 gap-y-1"
        >
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
          <span>{failureText.sentence}</span>
          {failureText.fix && (
            <Link href={failureText.fix.href} prefetch={false} className="font-semibold underline underline-offset-2">
              {failureText.fix.label}
            </Link>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t border-bg-border p-3 space-y-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`Message ${agentName}`}
          aria-label={`Message ${agentName}`}
          disabled={streaming}
          rows={2}
          className="w-full resize-none rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="pl-1 text-xs text-fg-dim">Enter to send, Shift+Enter for a new line</span>
          <button
            type="submit"
            disabled={!input.trim() || streaming}
            className="btn-send inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs"
          >
            {streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
