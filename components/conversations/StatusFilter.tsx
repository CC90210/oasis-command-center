"use client";

/**
 * StatusFilter — plan §3/§9: "same phasing" as ListTabs. Pre-Phase-3
 * (`enabled` false/undefined — the default), `conversation_threads.status`
 * doesn't exist yet, so this is render-only (tracks the active chip, never
 * hides a thread). Once CONVERSATIONS_SPINE=1 (`enabled=true`, plan §7),
 * InboxShell wires the same onChange to a real status-enum filter (Awaiting
 * Docs -> waiting_on_client) — this component only changes its tooltip.
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
  enabled,
}: {
  active: StatusKey | null;
  onChange: (k: StatusKey | null) => void;
  /** True once the Phase 3 spine is live — filtering is real. */
  enabled?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1 flex-wrap"
      title={enabled ? "Filter by status" : "Status filtering lands in Phase 3 (needs the conversation_threads.status column)"}
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
