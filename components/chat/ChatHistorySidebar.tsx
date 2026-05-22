"use client";

/**
 * ChatHistorySidebar — left drawer that lists the operator's past chat
 * sessions for the active agent. Click a row to load that session's
 * messages into the main composer (handled by parent).
 *
 * Built 2026-05-22 in response to CC: "there's no way to see my
 * previous conversations." Every chat already persists to
 * chat_messages on the server; this surface is just the visual + the
 * /api/chat/sessions wiring.
 *
 * Design:
 *   - Collapsed by default (one button toggles the drawer). When the
 *     screen is narrow the drawer overlays the chat; on wide screens
 *     it pushes the chat right via a flex layout in the parent.
 *   - Rows grouped by date bucket — Today / Yesterday / Last 7 days /
 *     Older — so a long history stays scannable.
 *   - Active session highlighted; clicking the active session re-loads
 *     it (idempotent, useful after a failed turn).
 *   - "+ New chat" button at the top mints a fresh session.
 *   - Search-by-content is a future polish; today's MVP just lists.
 *
 * The list refetches when the active agent changes (Bravo's threads
 * shouldn't bleed into Atlas's view) and after the parent signals a
 * new message has been persisted.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquare, Plus, X, History, Loader2 } from "lucide-react";
import { timeAgo } from "@/lib/fmt";

export type ChatSessionSummary = {
  id: string;
  agent_key: string;
  title: string | null;
  created_at: string;
  last_message_at: string;
  message_count: number;
  preview: string;
};

type Props = {
  /** Which agent's sessions to list. Bravo's chats are isolated from
   *  Atlas's etc. — same operator, different folders. */
  agentKey: string;
  /** Currently-open session id so the active row can be highlighted.
   *  null when the operator is on a fresh, unsaved chat. */
  activeSessionId: string | null;
  /** Fires when the operator clicks a session row. Parent loads the
   *  messages via GET /api/chat/sessions/[id] and resets state. */
  onLoadSession: (id: string) => void;
  /** Fires when the operator clicks "+ New chat". Parent clears the
   *  composer + messages and mints a new session_id on next send. */
  onNewChat: () => void;
  /** A tick value the parent bumps each time a chat turn finishes,
   *  triggering a refetch so the operator sees their just-completed
   *  session land in the list without a page reload. */
  refreshKey: number;
};

type DateBucket = "today" | "yesterday" | "last7" | "older";

function bucketOf(iso: string): DateBucket {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "older";
  const now = Date.now();
  const ms = now - t;
  const day = 24 * 60 * 60 * 1000;
  // "Today" + "yesterday" use calendar-day boundaries, not rolling
  // 24h, so 11:55pm yesterday → 12:05am today doesn't collapse them.
  const nowDate = new Date(now);
  const tDate = new Date(t);
  const sameDay =
    nowDate.getFullYear() === tDate.getFullYear() &&
    nowDate.getMonth() === tDate.getMonth() &&
    nowDate.getDate() === tDate.getDate();
  if (sameDay) return "today";
  const yesterday = new Date(now - day);
  const wasYesterday =
    yesterday.getFullYear() === tDate.getFullYear() &&
    yesterday.getMonth() === tDate.getMonth() &&
    yesterday.getDate() === tDate.getDate();
  if (wasYesterday) return "yesterday";
  if (ms <= 7 * day) return "last7";
  return "older";
}

const BUCKET_LABEL: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  older: "Older",
};

export function ChatHistorySidebar({
  agentKey,
  activeSessionId,
  onLoadSession,
  onNewChat,
  refreshKey,
}: Props) {
  const [open, setOpen] = useState<boolean>(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!agentKey) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/chat/sessions?agent=${encodeURIComponent(agentKey)}&limit=50`,
        { cache: "no-store" },
      );
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        sessions?: ChatSessionSummary[];
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setError(j.error || `http_${r.status}`);
        setSessions([]);
      } else {
        setSessions(j.sessions || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch_failed");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [agentKey]);

  // Refetch on agent change so Bravo's threads aren't visible while
  // looking at Atlas's chat — different folder, different list.
  useEffect(() => {
    if (open) void fetchSessions();
  }, [open, agentKey, refreshKey, fetchSessions]);

  // Group sessions into date buckets. useMemo so re-renders during
  // typing don't pay for the same scan.
  const grouped = useMemo(() => {
    const buckets: Record<DateBucket, ChatSessionSummary[]> = {
      today: [],
      yesterday: [],
      last7: [],
      older: [],
    };
    for (const s of sessions) {
      buckets[bucketOf(s.last_message_at || s.created_at)].push(s);
    }
    return buckets;
  }, [sessions]);

  // Toggle handle — a small button that's always rendered, even when
  // the drawer is closed, so the operator can find their way back.
  const toggle = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-bold px-2.5 py-1.5 rounded-lg border border-bg-border bg-bg-elev text-fg-muted hover:text-fg hover:border-accent/40 transition-colors"
      title={open ? "Hide chat history" : "Show your previous conversations"}
    >
      <History className="w-3.5 h-3.5" />
      History
      {sessions.length > 0 && (
        <span className="text-[10px] text-fg-dim font-mono">{sessions.length}</span>
      )}
    </button>
  );

  if (!open) {
    // Closed state: just the toggle button. Parent positions it where
    // it fits in the chat header.
    return toggle;
  }

  return (
    <>
      {toggle}
      <aside
        className="fixed inset-y-0 left-0 z-40 w-80 bg-bg border-r border-bg-border shadow-xl flex flex-col"
        aria-label="Chat history"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
          <div>
            <div className="font-bold text-sm text-fg">Previous chats</div>
            <div className="text-[11px] text-fg-dim mt-0.5">
              {agentKey.toUpperCase()} · scoped to you
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-md text-fg-dim hover:text-fg hover:bg-bg-elev"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-3 py-2 border-b border-bg-border">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              setOpen(false);
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-accent/40 bg-accent/10 hover:bg-accent/20 text-accent text-sm font-bold transition-colors"
          >
            <Plus className="w-4 h-4" />
            New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-fg-dim px-2 py-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading your chats…
            </div>
          )}
          {error && !loading && (
            <div className="text-xs text-status-warm px-2 py-3">
              Couldn&apos;t load chats: {error}
              <button
                type="button"
                onClick={() => void fetchSessions()}
                className="block mt-2 text-accent hover:text-accent-bright underline"
              >
                Try again
              </button>
            </div>
          )}
          {!loading && !error && sessions.length === 0 && (
            <div className="text-xs text-fg-dim px-2 py-6 text-center leading-relaxed">
              No previous chats with {agentKey.toUpperCase()} yet. Start a
              conversation and it&apos;ll show up here.
            </div>
          )}
          {!loading && !error && sessions.length > 0 && (
            <>
              {(["today", "yesterday", "last7", "older"] as DateBucket[]).map((bucket) => {
                const entries = grouped[bucket];
                if (entries.length === 0) return null;
                return (
                  <div key={bucket}>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-fg-dim px-2 mb-1.5">
                      {BUCKET_LABEL[bucket]}
                    </div>
                    <ul className="space-y-1">
                      {entries.map((s) => {
                        const isActive = s.id === activeSessionId;
                        const titleLine =
                          (s.title && s.title.trim().length > 0
                            ? s.title
                            : s.preview) || "Untitled chat";
                        return (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => {
                                onLoadSession(s.id);
                                setOpen(false);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${
                                isActive
                                  ? "border-accent/40 bg-accent/10 text-fg"
                                  : "border-transparent text-fg-muted hover:bg-bg-elev/60 hover:text-fg"
                              }`}
                              title={s.title || s.preview || ""}
                            >
                              <div className="flex items-start gap-2">
                                <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0 text-fg-dim" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium truncate">
                                    {titleLine}
                                  </div>
                                  <div className="text-[10px] text-fg-dim font-mono mt-0.5 flex items-center gap-2">
                                    <span>{timeAgo(s.last_message_at)}</span>
                                    <span>·</span>
                                    <span>
                                      {s.message_count}{" "}
                                      {s.message_count === 1 ? "msg" : "msgs"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
