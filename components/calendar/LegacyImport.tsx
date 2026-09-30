"use client";

/**
 * The confirm step before this browser's old saved week is written into the
 * calendar (CalendarApp importLegacy, lib/calendar/legacy.ts
 * legacyImportWrites). It says exactly what will be written, and, when the
 * calendar already holds the restored routine, that the browser's week
 * REPLACES it: importing on top of a restore used to put every block in
 * twice, in one click with no undo.
 */

import { useRef } from "react";
import { useDialogFocus } from "./ui";

type Props = {
  /** Events the import writes. */
  adds: number;
  /** Rows of the restored routine it removes (0: nothing is removed). */
  replacing: number;
  calendarName: string;
  /** Blocks shortened or left out on the weeks that meet Shabbat. */
  adjusted: string[];
  /** Blocks with no week left: every one falls inside Shabbat. */
  skipped: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function LegacyImport({ adds, replacing, calendarName, adjusted, skipped, busy, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = () => {
    if (!busy) onCancel();
  };
  useDialogFocus(ref, cancel);
  const replace = replacing > 0 && adds > 0;
  const title = adds === 0 ? "Nothing to bring in" : replace ? "Replace the restored routine?" : "Bring in this browser’s saved week?";
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-bg-rail/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cal-legacy-title"
        className="cal-float cal-enter w-full max-w-md rounded-lg border border-hairline bg-bg-elev p-5"
      >
        <h2 id="cal-legacy-title" className="text-base font-semibold text-fg">
          {title}
        </h2>
        <div className="mt-2 space-y-2 text-[13px] text-fg-muted">
          {adds === 0 ? (
            <p>Every block of the week saved in this browser falls inside Shabbat, so none of it can be added.</p>
          ) : replace ? (
            <>
              <p>
                {calendarName} already has the weekly routine restored from the old Schedule page ({plural(replacing, "event", "events")}).
                Adding this browser&rsquo;s saved week on top would put each block in twice.
              </p>
              <p className="text-fg">
                Replacing removes those {plural(replacing, "event", "events")}, with any changes you made to them, and adds{" "}
                {plural(adds, "event", "events")} from this browser&rsquo;s saved week.
              </p>
            </>
          ) : (
            <p className="text-fg">
              This adds {plural(adds, "repeating event", "repeating events")} to {calendarName}, from the week last saved in this browser on the
              old Schedule page.
            </p>
          )}
          {adjusted.length > 0 && <p>Planned around Shabbat (shortened or left out on the weeks that meet it): {adjusted.join(", ")}.</p>}
          {skipped.length > 0 && <p>Left out, every week falls inside Shabbat: {skipped.join(", ")}.</p>}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" data-variant="ghost" disabled={busy} onClick={cancel} data-autofocus>
            {replace ? "Keep the restored routine" : "Cancel"}
          </button>
          <button type="button" className="btn" data-variant={replace ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {adds === 0 ? "Stop offering it" : busy ? (replace ? "Replacing…" : "Adding…") : replace ? "Replace them" : "Add them"}
          </button>
        </div>
      </div>
    </div>
  );
}
