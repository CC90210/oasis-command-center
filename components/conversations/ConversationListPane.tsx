"use client";

/**
 * ConversationListPane — plan §3. ListTabs + StatusFilter (both render-only
 * P1 stubs) + the existing platform SearchBar/section chips (Text Torrent /
 * Email / Twilio / Kixie — carried over from the old ConversationsClient,
 * restyled) + the scrollable ConversationRow list.
 */
import { Search } from "lucide-react";
import type { ConversationThread, ConversationSource } from "@/lib/conversation-threading";
import { ConversationRow, type ThreadQuickActions } from "./ConversationRow";
import { ListTabs, type ListTabKey } from "./ListTabs";
import { StatusFilter, type StatusKey } from "./StatusFilter";

export type SectionKey = "all" | "texttorrent" | "email" | "twilio" | "kixie";

export const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "texttorrent", label: "Text Torrent" },
  { key: "email", label: "Email" },
  { key: "twilio", label: "Twilio" },
  { key: "kixie", label: "Kixie" },
];

export function ConversationListPane({
  filtered,
  selectedKey,
  onSelect,
  search,
  onSearchChange,
  section,
  onSectionChange,
  sectionCounts,
  listTab,
  onListTabChange,
  statusTab,
  onStatusTabChange,
  spineEnabled,
  quickActions,
}: {
  filtered: ConversationThread[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
  section: SectionKey;
  onSectionChange: (s: SectionKey) => void;
  sectionCounts: Record<string, number>;
  listTab: ListTabKey | null;
  onListTabChange: (k: ListTabKey) => void;
  statusTab: StatusKey | null;
  onStatusTabChange: (k: StatusKey | null) => void;
  /** Phase 3 (plan §7) — true once CONVERSATIONS_SPINE=1, switching
   *  ListTabs/StatusFilter from render-only to live filters. */
  spineEnabled?: boolean;
  /** Row hover quick-actions (assign to me / snooze / resolve) — null
   *  (hidden) until the spine is live; see InboxShell's `quickActions`. */
  quickActions?: ThreadQuickActions | null;
}) {
  return (
    <div className="h-full min-h-0 flex flex-col border-r border-bg-border bg-bg-panel">
      <div className="shrink-0 border-b border-bg-border p-3 space-y-2">
        <ListTabs active={listTab} onChange={onListTabChange} enabled={spineEnabled} />

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search contacts…"
            className="w-full bg-bg-deep/40 border border-bg-border rounded-md pl-8 pr-2 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
          />
        </div>

        <StatusFilter active={statusTab} onChange={onStatusTabChange} enabled={spineEnabled} />

        <div className="flex items-center gap-1.5 flex-wrap">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onSectionChange(s.key)}
              className={`text-[10.5px] px-2.5 py-1 rounded-md border transition-colors ${
                section === s.key
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg"
              }`}
            >
              {s.label}
              {sectionCounts[s.key] ? (
                <span className="ml-1 text-[10px] opacity-70">{sectionCounts[s.key]}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {filtered.length === 0 ? (
          <div className="p-4 text-xs text-fg-dim italic">
            No threads match.
          </div>
        ) : (
          filtered.map((t) => (
            <ConversationRow
              key={t.key}
              thread={t}
              active={selectedKey === t.key}
              onSelect={() => onSelect(t.key)}
              quickActions={quickActions}
            />
          ))
        )}
      </div>
    </div>
  );
}

export type { ConversationSource };
