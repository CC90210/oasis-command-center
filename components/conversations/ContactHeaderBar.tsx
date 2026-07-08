"use client";

/**
 * ContactHeaderBar — plan §3/§4. Sticky top of ThreadPane: avatar, name,
 * ContactChip x2 (phone + email — tel:/mailto: quick actions live inside
 * the chip itself), "Open lead" link, and the context-panel toggle for the
 * lg breakpoint where pane 3 is a slide-over rather than always-visible.
 */

import { PanelRight, ExternalLink } from "lucide-react";
import type { ConversationThread } from "@/lib/conversation-threading";
import { ContactChip } from "./ContactChip";
import { hashHsl, initials } from "./format";

export function ContactHeaderBar({
  thread,
  tenantSlug,
  contextPanelOpen,
  onToggleContextPanel,
  onComposeEmail,
}: {
  thread: ConversationThread;
  tenantSlug: string;
  contextPanelOpen: boolean;
  onToggleContextPanel: () => void;
  onComposeEmail: () => void;
}) {
  const { bg, fg } = hashHsl(thread.key);
  return (
    <div className="sticky top-0 z-10 shrink-0 border-b border-bg-border bg-bg-panel/95 backdrop-blur px-4 py-3 flex items-center gap-3">
      <div
        className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold"
        style={{ backgroundColor: bg, color: fg }}
        aria-hidden="true"
      >
        {initials(thread.contact_label)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg truncate">{thread.contact_label}</div>
        {thread.lead_id && (
          <a
            href={`/t/${tenantSlug}/leads?lead=${thread.lead_id}`}
            className="text-[10.5px] text-accent hover:underline inline-flex items-center gap-1"
          >
            Open lead <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
        <ContactChip kind="phone" value={thread.contact_phone} />
        <ContactChip kind="email" value={thread.contact_email} onComposeEmail={onComposeEmail} />
      </div>
      <button
        type="button"
        onClick={onToggleContextPanel}
        title={contextPanelOpen ? "Hide deal file" : "Show deal file"}
        aria-pressed={contextPanelOpen}
        className={`shrink-0 p-1.5 rounded-md border transition-colors ${
          contextPanelOpen
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-bg-border text-fg-dim hover:text-fg hover:border-fg-dim"
        }`}
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  );
}
