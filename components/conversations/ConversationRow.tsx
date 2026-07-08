"use client";

/**
 * ConversationRow — plan §3. 64-72px row: hash-HSL avatar, name, preview,
 * channel tag, timestamp, an unread indicator, and hover quick-actions.
 *
 * "Unread" note: `conversation_threads.unread_count` doesn't exist until
 * the Phase 3 spine. As a P1 approximation, the dot shows when the last
 * message on the thread was inbound (i.e. the merchant spoke last and
 * nobody has replied since) — a reasonable proxy, not the real thing.
 */
import { Phone, Mail, MessageSquare, StickyNote, PhoneCall } from "lucide-react";
import type { ConversationThread } from "@/lib/conversation-threading";
import { hashHsl, initials, relTime } from "./format";

function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const cls = className || "h-3 w-3";
  if (channel === "phone") return <Phone className={cls} />;
  if (channel === "email") return <Mail className={cls} />;
  if (channel === "note") return <StickyNote className={cls} />;
  return <MessageSquare className={cls} />;
}

export function ConversationRow({
  thread,
  active,
  onSelect,
}: {
  thread: ConversationThread;
  active: boolean;
  onSelect: () => void;
}) {
  const { bg, fg } = hashHsl(thread.key);
  const approxUnread = thread.last_direction === "inbound";

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
            <span className={`text-sm truncate ${approxUnread ? "font-semibold text-fg" : "font-medium text-fg/90"}`}>
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
        {approxUnread && (
          <span
            className="h-2 w-2 rounded-full bg-accent shrink-0 mt-1.5"
            title="Last message was inbound"
            aria-label="Unread"
          />
        )}
      </button>

      {/* Hover quick-actions — tel:/mailto:, don't steal the row click */}
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
      </div>
    </div>
  );
}
