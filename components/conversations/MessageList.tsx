"use client";

/**
 * MessageList — plan §3. Day dividers, a `data-message-id` ref registry
 * (exposed via `registryRef` so ContextPanel's future key-points click-to-
 * source (P2) can call `scrollToMessage`), skeleton bubbles while loading,
 * internal notes rendered as InternalNoteCard instead of a chat bubble.
 */

import { useCallback, useRef, type MutableRefObject } from "react";
import type { ConversationMessage } from "@/lib/conversation-threading";
import { MessageBubble, type BubbleStatus } from "./MessageBubble";
import { InternalNoteCard } from "./InternalNoteCard";
import { DayDivider } from "./DayDivider";
import { dayKey, dayLabel } from "./format";

export type MessageStatusMap = Record<string, BubbleStatus>;
export type MessageRegistry = MutableRefObject<Map<string, HTMLDivElement>>;

export function MessageList({
  messages,
  statusMap,
  onRetry,
  loading,
  registryRef,
}: {
  messages: ConversationMessage[];
  statusMap?: MessageStatusMap;
  onRetry?: (message: ConversationMessage) => void;
  loading?: boolean;
  registryRef?: MessageRegistry;
}) {
  const localRegistry = useRef<Map<string, HTMLDivElement>>(new Map());
  const registry = registryRef || localRegistry;

  const registerRef = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) registry.current.set(id, el);
      else registry.current.delete(id);
    },
    [registry],
  );

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <BubbleSkeleton key={i} align={i % 2 === 0 ? "start" : "end"} />
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0 flex items-center justify-center text-sm text-fg-dim">
        No messages yet.
      </div>
    );
  }

  const groups: { key: string; label: string; items: ConversationMessage[] }[] = [];
  for (const m of messages) {
    const k = dayKey(m.at);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(m);
    else groups.push({ key: k, label: dayLabel(m.at), items: [m] });
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-1">
      {groups.map((g) => (
        <div key={g.key}>
          <DayDivider label={g.label} />
          <div className="space-y-2.5 pb-1">
            {g.items.map((m) =>
              m.channel === "note" ? (
                <InternalNoteCard key={m.id} text={m.preview} at={m.at} />
              ) : (
                <MessageBubble
                  key={m.id}
                  message={m}
                  status={statusMap?.[m.id]}
                  onRetry={onRetry ? () => onRetry(m) : undefined}
                  registerRef={registerRef}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BubbleSkeleton({ align }: { align: "start" | "end" }) {
  return (
    <div className={`flex ${align === "end" ? "justify-end" : "justify-start"}`}>
      <div className="h-12 w-[55%] rounded-2xl bg-bg-elev/50 animate-pulse" />
    </div>
  );
}

/** Smooth-scroll to a message + flash it — the anchor for P2's key-points
 *  click-to-source. Exported now so ContextPanel can wire it once
 *  KeyPointsAccordion goes live without touching MessageList again. */
export function scrollToMessage(registry: MessageRegistry, id: string) {
  const el = registry.current.get(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-accent/60");
  setTimeout(() => el.classList.remove("ring-2", "ring-accent/60"), 2000);
}
