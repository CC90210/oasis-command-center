"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "./ui";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  { title: "Navigate", rows: [["T", "Today"], ["J  or  N", "Next period"], ["K  or  P", "Previous period"], ["G", "Go to date"]] },
  { title: "Views", rows: [["D", "Day"], ["X", "4 days"], ["W", "Week"], ["M", "Month"], ["Y", "Year"], ["A", "Schedule"]] },
  { title: "Events", rows: [["C", "Create event"], ["E", "Edit open event"], ["Delete", "Delete open event"], ["Ctrl  Z", "Undo last change"], ["Esc", "Close"]] },
  { title: "Other", rows: [["/", "Search"], ["?", "This list"]] },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg-rail/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="cal-keys-h" className="cal-float cal-enter w-full max-w-xl rounded-lg border border-hairline bg-bg-elev">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h2 id="cal-keys-h" className="text-base font-semibold text-fg">Keyboard shortcuts</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-6 px-5 py-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-[12px] font-semibold text-fg-muted">{g.title}</h3>
              <dl className="space-y-1.5 text-[13px]">
                {g.rows.map(([keys, what]) => (
                  <div key={what} className="flex items-center justify-between gap-4">
                    <dt className="text-fg">{what}</dt>
                    <dd className="flex gap-1">
                      {keys.split("  ").map((k) => (
                        <kbd key={k} className="kbd">{k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
