"use client";

/**
 * ListTabs — plan §3/§9. "renders P1; filters live P3 when assigned_to
 * exists." Pre-Phase-3 (`enabled` false/undefined — the default),
 * `conversation_threads.assigned_to` doesn't exist yet, so this control is
 * render-only: it tracks its own active tab but InboxShell's `filtered`
 * memo never actually applies it. Once CONVERSATIONS_SPINE=1
 * (`enabled=true`, plan §7), the parent wires the same onChange to a real
 * SQL/client-side filter — this component itself doesn't change behavior,
 * only its tooltip.
 */
export type ListTabKey = "mine" | "unassigned" | "all";

const TABS: { key: ListTabKey; label: string }[] = [
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "all", label: "All" },
];

export function ListTabs({
  active,
  onChange,
  enabled,
}: {
  active: ListTabKey | null;
  onChange: (k: ListTabKey) => void;
  /** True once the Phase 3 spine is live — filtering is real. */
  enabled?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-bg-border overflow-hidden"
      title={enabled ? "Filter by assignment" : "Assignment filtering lands in Phase 3 (needs the assigned_to column)"}
    >
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`text-[10.5px] font-semibold px-2.5 py-1 transition-colors ${
            active === t.key ? "bg-accent/15 text-accent" : "text-fg-dim hover:text-fg hover:bg-bg-elev"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
