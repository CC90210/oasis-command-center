"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, Loader2, Send, Sparkles } from "lucide-react";
import { COMMAND_DESCRIPTIONS, parseInput, type SlashCommandName } from "@/lib/chat-modes/slash-parser";
import { usePlanMode } from "@/lib/chat-modes/use-plan-mode";
import { failureCopy } from "@/lib/os/channel/outcome";

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

type Props = {
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
};

// sessionStorage key for plan mode. Per-tab so a tenant-preview reload
// doesn't drop the operator back into build mode mid-investigation.
// Distinct from ChatWidget's key — separate surfaces, separate state.
const PLAN_MODE_STORAGE_KEY = "oasis.tenant-chat.planMode.v1";

/** The commands that work in this chat. /agent and /model belong to the
 *  operator chat: a channel's agent is fixed, and its model is a setting. */
const CHANNEL_COMMANDS: SlashCommandName[] = ["clear", "compact", "plan", "build", "help"];
const CHANNEL_HELP = ["Slash commands:", ...CHANNEL_COMMANDS.map((c) => `  ${COMMAND_DESCRIPTIONS[c]}`)].join("\n");

export function AgentChat({
  tenantSlug,
  agentSlug,
  agentName,
  agentSubtitle,
  greeting,
  department,
  canManageAi = false,
  initialFailure = null,
}: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // A failure is a CODE (lib/os/channel/outcome.ts), rendered as one plain
  // sentence with a fix link. Raw provider text never reaches the screen.
  const [failure, setFailure] = useState<string | null>(initialFailure);
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

      // Slash commands — intercepted client-side, never hit the server.
      // Scoped to the commands that make sense for a single-agent chat:
      // /clear, /help, /plan, /build, /compact.
      const parsed = parseInput(trimmed);
      if (parsed.kind === "command") {
        const appendSystem = (content: string) =>
          setTurns((prev) => [...prev, { role: "system", content }]);
        switch (parsed.name) {
          case "clear":
            setTurns([]);
            setInput("");
            return;
          case "help":
            appendSystem(CHANNEL_HELP);
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
          case "agent":
            appendSystem("/agent isn't available here. Each department has its own channel.");
            setInput("");
            return;
          case "model":
            appendSystem("/model isn't available here. The AI model is chosen in Settings > AI brain.");
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
              const model = (payload as { model?: string }).model || null;
              setModelLabel(model);
              // Stamp the assistant placeholder with the runtime so the
              // pill renders under the message once streaming completes.
              // The server emits this `agent` event BEFORE any delta,
              // so the placeholder is already on screen at this point.
              if (model) {
                setTurns((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (last && last.role === "assistant") {
                    next[next.length - 1] = { ...last, runtime: model };
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
              setFailure(streamFailure);
            }
          }
        }
        if (!assistantText) {
          dropEmptyPlaceholder();
          // A stream that closed with no text and no reason is still a turn
          // that did not answer; say so rather than leave nothing.
          if (!streamFailure) setFailure("empty_reply");
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

  const failureText = failure ? failureCopy(failure, { canManageAi }) : null;

  // Min-height: on phones a hardcoded 640px is taller than a lot of
  // viewports (iPhone SE = 667px). Use a viewport-relative floor on
  // mobile, the original fixed floor on desktop.
  return (
    <div className="flex flex-col rounded-2xl border border-bg-border bg-bg-elev/40 backdrop-blur-sm min-h-[calc(100dvh-14rem)] md:min-h-[640px]">
      <div className="border-b border-bg-border px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <div className="font-bold text-sm text-fg">{agentName}</div>
            {agentSubtitle && (
              <div className="text-[10px] uppercase tracking-[0.16em] text-fg-dim">
                {agentSubtitle}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {planMode === "plan" && (
            // Plan-mode badge — click to /build. Mirrors ChatWidget's
            // badge in shape + behavior so the operator's muscle memory
            // from the /agents page transfers to the tenant preview.
            <button
              type="button"
              onClick={() => {
                setPlanMode("build");
                setTurns((prev) => [
                  ...prev,
                  { role: "system", content: "Execute mode active — full agent capabilities restored." },
                ]);
              }}
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border border-status-warm/40 bg-status-warm/10 text-status-warm hover:bg-status-warm/20 transition-colors"
              title="Plan mode active — agent restricted to read/research. Click to exit (same as /build)."
            >
              ● PLAN MODE
            </button>
          )}
          {modelLabel && (
            <span className="text-[10px] uppercase tracking-[0.16em] text-fg-dim font-mono">
              {modelLabel}
            </span>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
        {turns.length === 0 && (
          <div className="rounded-xl border border-bg-border bg-bg-elev/40 px-4 py-3 text-sm text-fg-muted leading-relaxed">
            {greeting || `Start chatting with ${agentName}. Press Enter to send.`}
          </div>
        )}
        {turns.map((t, i) => {
          // System pills (slash command echoes, mode-change confirmations)
          // get a distinct dimmed style so the operator can scan past them
          // without confusing them for assistant output.
          if (t.role === "system") {
            return (
              <div
                key={i}
                className="text-xs leading-relaxed whitespace-pre-wrap break-words text-fg-dim font-mono px-3 py-2 rounded-lg border border-bg-border/50 bg-bg-deep/40"
              >
                {t.content}
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
            <div key={i} className="contents">
              <div
                className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  t.role === "user"
                    ? "ml-8 rounded-xl bg-accent-soft border border-accent-muted/30 px-4 py-2.5 text-fg"
                    : "mr-8 rounded-xl bg-bg-elev/70 border border-bg-border px-4 py-2.5 text-fg-muted"
                }`}
              >
                {t.content || (streaming && i === turns.length - 1 ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent inline" />
                ) : null)}
              </div>
              {showRuntime && (
                <div className="text-[10px] text-fg-dim font-mono ml-2 mr-8 -mt-2">
                  via {t.runtime}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {failureText && (
        <div
          role="alert"
          className="mx-5 mb-2 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200 inline-flex flex-wrap items-start gap-x-2 gap-y-1"
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
