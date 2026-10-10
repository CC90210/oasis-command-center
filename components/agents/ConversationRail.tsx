"use client";

import { useState } from "react";
import { Check, Loader2, MessageSquarePlus, Pencil, Trash2, X } from "lucide-react";
import type { ConversationSummary, DeptChatState } from "./run-store";

/** "just now", "5 min ago", "yesterday", else the date: a chat list is scanned by when, not by a timestamp. */
export function whenLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Row({
  c,
  current,
  onOpen,
  onRename,
  onDelete,
}: {
  c: ConversationSummary;
  current: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(c.title);

  if (mode === "rename") {
    return (
      <li className="px-2 py-1.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onRename(draft.trim());
            setMode("view");
          }}
          className="flex items-center gap-1"
        >
          <input
            autoFocus
            value={draft}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setMode("view")}
            aria-label="Chat name"
            className="min-w-0 flex-1 rounded-md border border-bg-border bg-bg-deep/80 px-2 py-1 text-xs text-fg focus:border-accent/50 focus:outline-none"
          />
          <button type="submit" aria-label="Save name" className="rounded-md p-1.5 text-fg-muted hover:bg-bg-elev hover:text-fg">
            <Check className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Cancel" onClick={() => setMode("view")} className="rounded-md p-1.5 text-fg-muted hover:bg-bg-elev hover:text-fg">
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      </li>
    );
  }

  if (mode === "delete") {
    return (
      <li className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-fg-muted">
        <span>Delete this chat?</span>
        <span className="flex gap-1">
          <button
            type="button"
            onClick={() => {
              setMode("view");
              onDelete();
            }}
            className="rounded-md border border-status-hot/40 px-2 py-1 text-status-hot hover:bg-status-hot/10"
          >
            Delete
          </button>
          <button type="button" onClick={() => setMode("view")} className="rounded-md px-2 py-1 hover:bg-bg-elev">
            Keep
          </button>
        </span>
      </li>
    );
  }

  return (
    <li className={`group flex items-center gap-1 rounded-lg ${current ? "bg-accent-soft" : "hover:bg-bg-elev/60"}`}>
      <button type="button" onClick={onOpen} aria-current={current ? "true" : undefined} className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left">
        <span className="truncate text-[13px] leading-tight text-fg">{c.title || "New chat"}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-fg-dim">
          {c.activeRuns > 0 ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-accent" aria-hidden />
              Working
            </>
          ) : (
            whenLabel(c.lastMessageAt)
          )}
        </span>
      </button>
      <span className="flex shrink-0 pr-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <button
          type="button"
          aria-label={`Rename ${c.title || "this chat"}`}
          onClick={() => {
            setDraft(c.title);
            setMode("rename");
          }}
          className="rounded-md p-1.5 text-fg-dim hover:bg-bg-elev hover:text-fg"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Delete ${c.title || "this chat"}`}
          onClick={() => setMode("delete")}
          className="rounded-md p-1.5 text-fg-dim hover:bg-bg-elev hover:text-status-hot"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </li>
  );
}

/**
 * Past chats in one department channel: reopen, rename, delete, start new.
 * Yours only (the list is the server's, scoped to you and your workspace). A
 * chat that is still working says so.
 */
export function ConversationRail({
  state,
  onOpen,
  onNew,
  onRename,
  onDelete,
}: {
  state: Pick<DeptChatState, "conversations" | "conversationId" | "listState">;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const { conversations, conversationId, listState } = state;
  return (
    <nav aria-label="Past chats" className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <button type="button" onClick={onNew} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-hairline px-3 py-2 text-xs font-medium text-fg-muted hover:bg-bg-elev hover:text-fg">
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
        New chat
      </button>
      {listState === "loading" && conversations.length === 0 ? (
        <p className="px-3 py-2 text-xs text-fg-dim">Loading your chats...</p>
      ) : listState === "failed" && conversations.length === 0 ? (
        <p className="px-3 py-2 text-xs text-fg-dim">Your past chats could not be loaded.</p>
      ) : conversations.length === 0 ? (
        <p className="px-3 py-2 text-xs leading-relaxed text-fg-dim">Chats you start here are saved. Come back to any of them later.</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <Row
              key={c.id}
              c={c}
              current={c.id === conversationId}
              onOpen={() => onOpen(c.id)}
              onRename={(t) => onRename(c.id, t)}
              onDelete={() => onDelete(c.id)}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
