"use client";

import { useRef, useState } from "react";
import type { EditScope } from "@/lib/calendar/types";
import { useDialogFocus } from "./ui";

type Props = {
  action: "edit" | "delete";
  /** "following" is pointless on the first occurrence; "all" alone covers it. */
  allowFollowing: boolean;
  /** A changed repeat rule cannot apply to a single occurrence. */
  allowThis: boolean;
  onPick: (scope: EditScope) => void;
  onCancel: () => void;
};

export function ScopeDialog({ action, allowFollowing, allowThis, onPick, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onCancel);
  const [scope, setScope] = useState<EditScope>(allowThis ? "this" : allowFollowing ? "following" : "all");
  const options: { value: EditScope; label: string }[] = [
    ...(allowThis ? [{ value: "this" as const, label: "This event" }] : []),
    ...(allowFollowing ? [{ value: "following" as const, label: "This and following events" }] : []),
    { value: "all", label: "All events" },
  ];
  const title = action === "delete" ? "Delete recurring event" : "Edit recurring event";
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-bg-rail/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="cal-scope-title" className="cal-float cal-enter w-full max-w-sm rounded-lg border border-hairline bg-bg-elev p-5">
        <h2 id="cal-scope-title" className="text-base font-semibold text-fg">{title}</h2>
        <fieldset className="mt-4 space-y-1">
          <legend className="sr-only">Apply to</legend>
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-[13px] text-fg hover:bg-bg-hover">
              <input
                type="radio"
                name="cal-scope"
                value={o.value}
                checked={scope === o.value}
                onChange={() => setScope(o.value)}
                className="h-4 w-4 accent-[rgb(var(--c-accent))]"
                data-autofocus={scope === o.value ? true : undefined}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" data-variant="ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn" data-variant={action === "delete" ? "danger" : "primary"} onClick={() => onPick(scope)}>
            {action === "delete" ? "Delete" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
