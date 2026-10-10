"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertCircle, History, Loader2, MessageSquarePlus, Send, Square, X } from "lucide-react";
import { parseInput } from "@/lib/chat-modes/slash-parser";
import { usePlanMode } from "@/lib/chat-modes/use-plan-mode";
import { failureCopy } from "@/lib/os/channel/outcome";
import { deskToolsNote } from "@/lib/os/desk/catalog";
import { CHAT_LIST_CLASS, CHAT_VIA_CLASS, chatBubbleClass, chatRowClass } from "./chat-layout";
import { PLAN_MODE_STORAGE_KEY, chatCommands, chatHelp, runFailureSentence, unavailableCommandCopy } from "./chat-shared";
import { ChannelHeader } from "./ChannelHeader";
import { ActivityTrail } from "./ActivityTrail";
import { ConversationRail } from "./ConversationRail";
import {
  deleteConversation,
  getServerState,
  getState,
  loadInitial,
  newChat,
  openConversation,
  renameConversation,
  sendMessage,
  stopRun,
  subscribe,
  type ChatItem,
} from "./run-store";
import type { ChannelProps } from "./AgentChat";

/**
 * A department channel. Every message is a saved RUN (lib/os/runs): it keeps
 * working when you leave this page, you can send more while it works (they
 * queue, or you can stop the one that is running), you can watch what the
 * department is doing as it does it, and every conversation is kept to reopen
 * later. The state lives in components/agents/run-store.ts, outside React, so
 * this component can unmount and mount again without losing a thing.
 */
export function DepartmentChat({
  agentSlug,
  agentName,
  agentSubtitle,
  greeting,
  department,
  canManageAi = false,
  initialFailure = null,
  poweredBy = null,
}: ChannelProps & { department: string }) {
  const state = useSyncExternalStore(
    subscribe,
    () => getState(department),
    () => getServerState(department),
  );
  const [input, setInput] = useState("");
  // The channel's last recorded turn failed: say so until the next message is sent.
  const [banner, setBanner] = useState<string | null>(initialFailure);
  const [notes, setNotes] = useState<string[]>([]);
  const [railOpen, setRailOpen] = useState(false);
  const [planMode, setPlanMode] = usePlanMode(PLAN_MODE_STORAGE_KEY);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    void loadInitial(department);
  }, [department]);

  // Follow the bottom while it writes, unless the person scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [state.items, notes]);

  const { items } = state;
  const working = items.find((i) => i.status === "running");
  const waiting = items.filter((i) => i.status === "queued" || i.status === "sending").length;
  const latest = [...items].reverse().find((i) => i.view.agent);
  const toolsNote = latest ? deskToolsNote((latest.view.agent as { tools?: unknown }).tools) : null;
  const modelLabel = latest && typeof latest.view.agent?.model === "string" ? latest.view.agent.model : null;

  const submit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const parsed = parseInput(trimmed);
      if (parsed.kind === "command") {
        const say = (content: string) => setNotes((prev) => [...prev, content]);
        setInput("");
        if (!chatCommands(department).includes(parsed.name)) {
          say(unavailableCommandCopy(parsed.name));
          return;
        }
        switch (parsed.name) {
          case "clear":
            // A fresh chat. The one you leave stays in Past chats.
            setNotes([]);
            newChat(department);
            return;
          case "help":
            say(chatHelp(department));
            return;
          case "plan":
            setPlanMode("plan");
            say("Plan mode active — agent reads + reasons but write tools are gated server-side. Hit /build (or the Execute toggle) when you're ready to run.");
            return;
          case "build":
            setPlanMode("build");
            say("Execute mode active — full agent capabilities restored.");
            return;
        }
        return;
      }
      setBanner(null);
      setInput("");
      stick.current = true;
      void sendMessage(department, { agentSlug, text: trimmed, chatMode: planMode });
      inputRef.current?.focus();
    },
    [department, agentSlug, planMode, setPlanMode],
  );

  const bannerCopy = banner ? failureCopy(banner, { canManageAi }) : null;
  const rail = (
    <ConversationRail
      state={state}
      onOpen={(id) => {
        setNotes([]);
        setRailOpen(false);
        void openConversation(department, id);
      }}
      onNew={() => {
        setNotes([]);
        setRailOpen(false);
        newChat(department);
        inputRef.current?.focus();
      }}
      onRename={(id, title) => void renameConversation(department, id, title)}
      onDelete={(id) => void deleteConversation(department, id)}
    />
  );

  return (
    <div className="flex overflow-hidden rounded-2xl border border-bg-border bg-bg-elev/40 backdrop-blur-sm min-h-[calc(100dvh-14rem)] md:min-h-[640px]">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-bg-border md:flex" aria-label="Past chats">
        {rail}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader
          agentName={agentName}
          agentSubtitle={agentSubtitle}
          planMode={planMode}
          onExitPlan={() => {
            setPlanMode("build");
            setNotes((prev) => [...prev, "Execute mode active — full agent capabilities restored."]);
          }}
          poweredBy={poweredBy}
          modelLabel={modelLabel}
          canManageAi={canManageAi}
          actions={
            <>
              <button
                type="button"
                onClick={() => setRailOpen((o) => !o)}
                aria-expanded={railOpen}
                className="inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-elev hover:text-fg md:hidden"
              >
                <History className="h-3 w-3" aria-hidden />
                Past chats
              </button>
              <button
                type="button"
                onClick={() => {
                  setNotes([]);
                  newChat(department);
                  inputRef.current?.focus();
                }}
                className="hidden items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-elev hover:text-fg sm:inline-flex md:hidden"
              >
                <MessageSquarePlus className="h-3 w-3" aria-hidden />
                New chat
              </button>
            </>
          }
        />

        {railOpen && <div className="max-h-72 overflow-y-auto border-b border-bg-border md:hidden">{rail}</div>}

        {toolsNote && <div className="border-b border-bg-border px-5 py-2 text-[11px] text-fg-dim">{toolsNote}</div>}

        {poweredBy?.note && <p className="border-b border-hairline px-5 py-2 text-[11px] leading-snug text-status-warm">{poweredBy.note}</p>}

        {state.notice && (
          <p role="alert" className="border-b border-hairline px-5 py-2 text-[11px] leading-snug text-status-warm">
            {runFailureSentence(state.notice, { canManageAi })}
          </p>
        )}

        {/* Layout: components/agents/chat-layout.ts (bubbles sized to their text, yours right and the department's left, the "via" line under its bubble). */}
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          }}
          role="log"
          aria-label={`${agentName} conversation`}
          className={CHAT_LIST_CLASS}
        >
          {items.length === 0 && !state.opening && (
            <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-3 text-sm text-fg-muted leading-[1.65]">
              {greeting || `Start chatting with ${agentName}. Press Enter to send.`}
            </div>
          )}
          {state.opening && (
            <div className="flex items-center gap-2 px-1 text-xs text-fg-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Opening this chat...
            </div>
          )}
          {items.map((item) => (
            <Message key={item.key} item={item} canManageAi={canManageAi} onStop={() => item.runId && void stopRun(department, item.runId)} />
          ))}
          {notes.map((n, i) => (
            <div key={`note-${i}`} className={chatRowClass("system")}>
              <div className={chatBubbleClass("system")}>{n}</div>
            </div>
          ))}
        </div>

        {bannerCopy && (
          <div
            role="alert"
            className="mx-5 mb-2 rounded-xl border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-xs text-status-hot inline-flex flex-wrap items-start gap-x-2 gap-y-1"
          >
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
            <span>{bannerCopy.sentence}</span>
            {bannerCopy.fix && (
              <Link href={bannerCopy.fix.href} prefetch={false} className="font-semibold underline underline-offset-2">
                {bannerCopy.fix.label}
              </Link>
            )}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="border-t border-bg-border p-3 space-y-2"
        >
          {/* Never disabled: a message sent while one is working waits its turn. */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            // Enter sends, Shift+Enter adds a line - the same as Today's Ask composer
            // (components/os/today/AskComposer.tsx). isComposing: Enter that confirms an IME candidate is not a send.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(input);
              }
            }}
            placeholder={working ? `Message ${agentName} - it will go next` : `Message ${agentName}`}
            aria-label={`Message ${agentName}`}
            rows={2}
            maxLength={8000}
            className="w-full resize-none rounded-xl border border-bg-border bg-bg-deep/80 px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="pl-1 text-xs text-fg-dim">
              {working ? (
                waiting > 0 ? `${waiting} waiting. Enter to add another` : "Working. Enter to queue a message"
              ) : (
                "Enter to send, Shift+Enter for a new line"
              )}
            </span>
            <div className="flex items-center gap-2">
              {working && working.runId && (
                <button
                  type="button"
                  disabled={working.stopping}
                  onClick={() => working.runId && void stopRun(department, working.runId)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-bg-elev hover:text-fg disabled:opacity-60"
                >
                  <Square className="h-3 w-3" aria-hidden />
                  {working.stopping ? "Stopping..." : "Stop"}
                </button>
              )}
              <button type="submit" disabled={!input.trim()} className="btn-send inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
                <Send className="h-3 w-3" />
                {working ? "Queue" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/** One message and its reply: your words, then what the department did and what it said. */
export function Message({ item, canManageAi, onStop }: { item: ChatItem; canManageAi: boolean; onStop: () => void }) {
  const running = item.status === "running";
  const waitingTurn = item.status === "queued" || item.status === "sending";
  const copy = item.failure ? failureCopy(item.failure.code, { canManageAi, model: item.failure.model }) : null;
  const failure =
    item.failure && copy
      ? { sentence: runFailureSentence(item.failure.code, { canManageAi, model: item.failure.model }), fix: copy.fix }
      : null;
  const reply = running || item.status === "sending" ? item.view.text || item.text : item.text;
  const shown = reply.trim().length > 0;
  return (
    <>
      <div className={chatRowClass("user")}>
        <div className={chatBubbleClass("user")}>{item.userText}</div>
        {waitingTurn && (
          <div className="flex items-center gap-2 px-1 text-[11px] text-fg-dim">
            {item.status === "sending" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Sending
              </>
            ) : (
              <>
                Queued - goes next
                <button type="button" onClick={onStop} aria-label="Remove this queued message" className="rounded p-0.5 hover:bg-bg-elev hover:text-fg">
                  <X className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {!waitingTurn && (
        <div className={chatRowClass("assistant")}>
          <ActivityTrail view={item.view} running={running} />
          {shown && <div className={chatBubbleClass("assistant")}>{reply}</div>}
          {item.status === "cancelled" && <div className={CHAT_VIA_CLASS}>{shown ? "Stopped. This is as far as it got." : "Stopped."}</div>}
          {failure && (
            <div
              role="alert"
              className="max-w-[min(42rem,88%)] rounded-xl border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-xs text-status-hot inline-flex flex-wrap items-start gap-x-2 gap-y-1"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{failure.sentence}</span>
              {failure.fix && (
                <Link href={failure.fix.href} prefetch={false} className="font-semibold underline underline-offset-2">
                  {failure.fix.label}
                </Link>
              )}
            </div>
          )}
          {item.status === "done" && item.via && shown && <div className={CHAT_VIA_CLASS}>via {item.via}</div>}
        </div>
      )}
    </>
  );
}
