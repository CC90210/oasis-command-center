"use client";

/**
 * StatusFilter — plan §3/§9 Phase 1: "same phasing" as ListTabs. The
 * `conversation_threads.status` enum doesn't exist until Phase 3, so this
 * is render-only (tracks the active chip, never hides a thread). Wired for
 * a real `onChange` filter once the spine lands.
 */
export type StatusKey = "open" | "awaiting_docs" | "snoozed" | "closed_funded";

const STATUSES: { key: StatusKey; label: string; tone: string }[] = [
  { key: "open", label: "Open", tone: "text-status-info" },
  { key: "awaiting_docs", label: "Awaiting Docs", tone: "text-status-warm" },
  { key: "snoozed", label: "Snoozed", tone: "text-fg-dim" },
  { key: "closed_funded", label: "Closed / Funded", tone: "text-status-engaged" },
];

export function StatusFilter({
  active,
  onChange,
}: {
  active: StatusKey | null;
  onChange: (k: StatusKey | null) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 flex-wrap"
      title="Status filtering lands in Phase 3 (needs the conversation_threads.status column)"
    >
      {STATUSES.map((s) => {
        const isActive = active === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(isActive ? null : s.key)}
            className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
              isActive
                ? "border-accent/50 bg-accent/10 text-accent"
                : `border-bg-border bg-bg-elev/30 hover:text-fg ${s.tone}`
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
