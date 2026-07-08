"use client";

/**
 * ConversationRow — plan §3/§7. 64-72px row: hash-HSL avatar, name, preview,
 * channel tag, timestamp, an unread indicator, and hover quick-actions.
 *
 * "Unread" note: pre-Phase-3, `conversation_threads.unread_count` doesn't
 * exist, so the dot is an approximation — it shows when the last message on
 * the thread was inbound (the merchant spoke last and nobody has replied
 * since). Once the spine is live (`thread.unread_count` defined), the dot
 * switches to the real per-thread count.
 *
 * Quick-actions: tel:/mailto: are always shown. Assign-to-me / snooze /
 * resolve (`quickActions`) only render once the spine is live — they PATCH
 * conversation_threads, which doesn't exist before the 112 migration.
 */
import { useEffect, useRef, useState } from "react";
import { Phone, Mail, MessageSquare, StickyNote, PhoneCall, UserCheck, Clock, CheckCircle2 } from "lucide-react";
import type { ConversationThread } from "@/lib/conversation-threading";
import { hashHsl, initials, relTime } from "./format";

export type ThreadQuickActions = {
  onAssignToMe: (key: string) => void;
  onResolve: (key: string) => void;
  onSnooze: (key: string, hours: number) => void;
};

const SNOOZE_PRESETS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "Tomorrow", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
];

function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const cls = className || "h-3 w-3";
  if (channel === "phone") return <Phone className={cls} />;
  if (channel === "email") return <Mail className={cls} />;
  if (channel === "note") return <StickyNote className={cls} />;
  return <MessageSquare className={cls} />;
}

function SnoozeMenu({ onPick }: { onPick: (hours: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Snooze"
        className="p-1 rounded text-fg-dim hover:text-accent hover:bg-accent/10"
      >
        <Clock className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-1 w-32 rounded-md border border-bg-border bg-bg-elev shadow-elev z-20 py-1">
          {SNOOZE_PRESETS.map((p) => (
            <button
              key={p.hours}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPick(p.hours);
              }}
              className="w-full text-left px-2.5 py-1 text-[11px] text-fg hover:bg-bg-panel"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConversationRow({
  thread,
  active,
  onSelect,
  quickActions,
}: {
  thread: ConversationThread;
  active: boolean;
  onSelect: () => void;
  quickActions?: ThreadQuickActions | null;
}) {
  const { bg, fg } = hashHsl(thread.key);
  const unread = thread.unread_count != null ? thread.unread_count > 0 : thread.last_direction === "inbound";

  return (
    <div className={`group relative border-b border-bg-border/50 ${active ? "bg-bg-elev/50" : "hover:bg-bg-elev/25"} transition-colors`}>
      <button type="button" onClick={onSelect} className="w-full text-left px-3 py-2.5 min-h-[64px] flex items-start gap-2.5">
        <div
          className="h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5"
          style={{ backgroundColor: bg, color: fg }}
          aria-hidden="true"
        >
          {initials(thread.contact_label)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-sm truncate ${unread ? "font-semibold text-fg" : "font-medium text-fg/90"}`}>
              {thread.contact_label}
            </span>
            <span className="text-[10px] text-fg-dim shrink-0">{relTime(thread.last_at)}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="flex items-center gap-1 text-fg-dim shrink-0">
              {thread.channels.slice(0, 3).map((ch) => (
                <ChannelIcon key={ch} channel={ch} />
              ))}
            </span>
            <span className="text-xs text-fg-muted truncate">{thread.last_preview || "—"}</span>
          </div>
        </div>
        {unread && (
          <span
            className="h-2 w-2 rounded-full bg-accent shrink-0 mt-1.5"
            title={thread.unread_count != null ? `${thread.unread_count} unread` : "Last message was inbound"}
            aria-label="Unread"
          />
        )}
      </button>

      {/* Hover quick-actions — tel:/mailto: (+ assign/snooze/resolve once the
          spine is live), don't steal the row click */}
      <div className="absolute right-3 bottom-2 hidden group-hover:flex items-center gap-1 bg-bg-panel/90 rounded-md">
        {thread.contact_phone && (
          <a
            href={`tel:${thread.contact_phone}`}
            onClick={(e) => e.stopPropagation()}
            title="Call"
            className="p-1 rounded text-fg-dim hover:text-accent hover:bg-accent/10"
          >
            <PhoneCall className="h-3 w-3" />
          </a>
        )}
        {thread.contact_email && (
          <a
            href={`mailto:${thread.contact_email}`}
            onClick={(e) => e.stopPropagation()}
            title="Email"
            className="p-1 rounded text-fg-dim hover:text-accent hover:bg-accent/10"
          >
            <Mail className="h-3 w-3" />
          </a>
        )}
        {quickActions && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                quickActions.onAssignToMe(thread.key);
              }}
              title="Assign to me"
              className="p-1 rounded text-fg-dim hover:text-accent hover:bg-accent/10"
            >
              <UserCheck className="h-3 w-3" />
            </button>
            <SnoozeMenu onPick={(hours) => quickActions.onSnooze(thread.key, hours)} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                quickActions.onResolve(thread.key);
              }}
              title="Resolve (close)"
              className="p-1 rounded text-fg-dim hover:text-status-engaged hover:bg-status-engaged/10"
            >
              <CheckCircle2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
