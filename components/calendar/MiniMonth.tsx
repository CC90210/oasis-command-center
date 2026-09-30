"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, monthLong, monthMatrix, sameDay, startOfMonth, weekdayShort } from "@/lib/calendar/dates";

type Props = {
  selected: Date;
  now: Date;
  weekStartsOn: number;
  /** Local-date keys (ms of local midnight) that have at least one event. */
  busyDays?: Set<number>;
  /** Highlight the visible range, e.g. the current week. */
  rangeStart?: Date;
  rangeEnd?: Date;
  onPick: (day: Date) => void;
  /** Controlled month (year view); uncontrolled when omitted. */
  month?: Date;
  compact?: boolean;
};

export function MiniMonth({ selected, now, weekStartsOn, busyDays, rangeStart, rangeEnd, onPick, month: controlled, compact }: Props) {
  const [own, setOwn] = useState(() => startOfMonth(selected));
  const [lastSelected, setLastSelected] = useState(selected);
  // Follow the main calendar when it navigates to another month.
  if (!controlled && !sameDay(lastSelected, selected)) {
    setLastSelected(selected);
    if (selected.getMonth() !== own.getMonth() || selected.getFullYear() !== own.getFullYear()) setOwn(startOfMonth(selected));
  }
  const month = controlled ?? own;
  const weeks = monthMatrix(month, weekStartsOn);
  const title = `${monthLong(month.getMonth())} ${month.getFullYear()}`;

  return (
    <div className="select-none" aria-label={title}>
      <div className="mb-1 flex items-center justify-between">
        <span className={`pl-1 font-semibold text-fg ${compact ? "text-sm" : "text-[13px]"}`}>{title}</span>
        {!controlled && (
          <div className="flex">
            <button type="button" className="icon-btn h-7 w-7" onClick={() => setOwn(addMonths(own, -1))} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" className="icon-btn h-7 w-7" onClick={() => setOwn(addMonths(own, 1))} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <table className="w-full table-fixed border-collapse text-center text-[11px]">
        <thead>
          <tr>
            {weeks[0].map((d) => (
              <th key={d.getDay()} scope="col" className="h-6 font-medium text-fg-dim" abbr={weekdayShort(d.getDay())}>
                {weekdayShort(d.getDay())[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((d) => {
                const inMonth = d.getMonth() === month.getMonth();
                const today = sameDay(d, now);
                const isSel = sameDay(d, selected);
                const inRange = rangeStart && rangeEnd && d >= rangeStart && d < rangeEnd;
                const busy = busyDays?.has(d.getTime());
                return (
                  <td key={d.getTime()} className={`p-0 ${inRange ? "bg-active" : ""}`}>
                    <button
                      type="button"
                      onClick={() => onPick(d)}
                      aria-label={d.toDateString()}
                      aria-current={today ? "date" : undefined}
                      aria-pressed={isSel}
                      className={`relative mx-auto grid h-7 w-7 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        today ? "bg-accent-muted font-semibold text-fg" : isSel ? "bg-accent/20 font-semibold text-fg" : inMonth ? "text-fg hover:bg-bg-hover" : "text-fg-dim hover:bg-bg-hover"
                      }`}
                    >
                      {d.getDate()}
                      {busy && !today && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-fg-muted" aria-hidden />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
