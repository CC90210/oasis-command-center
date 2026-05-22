"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Send, Sparkles } from "lucide-react";
import { parseInput, renderHelp } from "@/lib/chat-modes/slash-parser";
import { usePlanMode } from "@/lib/chat-modes/use-plan-mode";

type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  /** Which model+provider serviced this assistant turn. Captured from
   *  the `agent` SSE event the server emits right before streaming
   *  text. Surfaces as a "via X" pill under the message so operators
   *  can verify which runtime actually answered — same affordance as
   *  the main /agents page chat. */
  runtime?: string;
};

type Props = {
  tenantSlug: string;
  agentSlug: string;
  agentName: string;
  agentSubtitle?: string;
  /** Optional welcome message rendered above the empty-state. */
  greeting?: string;
};

// sessionStorage key for plan mode. Per-tab so a tenant-preview reload
// doesn't drop the operator back into build mode mid-investigation.
// Distinct from ChatWidget's key — separate surfaces, separate state.
const PLAN_MODE_STORAGE_KEY = "oasis.tenant-chat.planMode.v1";

export function AgentChat({
  tenantSlug,
  agentSlug,
  agentName,
  agentSubtitle,
  greeting,
}: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  // Plan vs Build — OpenCode-style state machine. /plan filters write
  // intent out of the agent's system prompt (server-side, see
  // app/api/agents/chat/route.ts); /build restores full behavior.
  // The shared usePlanMode hook owns sessionStorage hydration +
  // persistence; the per-surface key keeps this state isolated from
  // the main /agents page chat.
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
      setError(null);

      // Slash commands — intercepted client-side, never hit the server.
      // Mirrors ChatWidget's surface but scoped to commands that make
      // sense for a single-agent preview chat: /clear, /help, /plan,
      // /build. /agent and /model don't apply here (agent is fixed by
      // route; model swap belongs in Settings, not the tenant preview).
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
            appendSystem(renderHelp());
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
          case "model":
            appendSystem(
              `/${parsed.name} isn't available on the tenant preview chat — switch agents via the marketplace, or use the main /agents page for in-place /model + /agent.`,
            );
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
                  error?: string;
                  message?: string;
                };
                if (!res.ok || !body.ok || !body.summary) {
                  const detail = body.message || body.error || `http_${res.status}`;
                  appendSystem(`Compact failed: ${detail}. History unchanged.`);
                  return;
                }
                setTurns([
                  {
                    role: "assistant",
                    content: `--- Context summary ---\n\n${body.summary.trim()}\n\n--- End summary ---`,
                  },
                ]);
              } catch (err) {
                appendSystem(
                  `Compact failed: ${err instanceof Error ? err.message : "network_error"}. History unchanged.`,
                );
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

      try {
        const res = await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenant_slug: tenantSlug,
            agent_slug: agentSlug,
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
          const body = await res.json().catch(() => ({}));
          const detail = (body as { error?: string; message?: string }).message ||
            (body as { error?: string }).error ||
            `HTTP ${res.status}`;
          setError(detail);
          setTurns((prev) => prev.slice(0, -1));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";

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
              setError((payload as { message?: string }).message || "stream_error");
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "network_error");
        setTurns((prev) => prev.slice(0, -1));
      } finally {
        setStreaming(false);
        inputRef.current?.focus();
      }
    },
    [tenantSlug, agentSlug, streaming, turns]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="flex flex-col rounded-2xl border border-bg-border bg-bg-elev/40 backdrop-blur-sm min-h-[640px]">
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

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {turns.length === 0 && (
          <div className="rounded-xl border border-bg-border bg-bg-elev/40 px-4 py-3 text-sm text-fg-muted leading-relaxed">
            {greeting || `Start chatting with ${agentName}. Use Cmd/Ctrl+Enter to send.`}
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

      {error && (
        <div className="mx-5 mb-2 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200 inline-flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t border-bg-border p-3 space-y-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`Message ${agentName}... (Cmd/Ctrl+Enter to send)`}
          disabled={streaming}
          rows={2}
          className="w-full resize-none rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center justify-end">
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
