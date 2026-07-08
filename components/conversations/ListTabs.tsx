"use client";

/**
 * ListTabs — plan §3/§9 Phase 1: "renders P1; filters live P3 when
 * assigned_to exists." `conversation_threads.assigned_to` doesn't exist
 * until the Phase 3 spine migration, so this control is intentionally
 * render-only right now — it tracks its own active tab and is wired for a
 * future `onChange` that will actually filter, but doesn't hide any threads
 * yet. Left un-selected by default (no highlighted tab) so it never implies
 * a filter is active when it isn't.
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
}: {
  active: ListTabKey | null;
  onChange: (k: ListTabKey) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-bg-border overflow-hidden"
      title="Assignment filtering lands in Phase 3 (needs the assigned_to column)"
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
