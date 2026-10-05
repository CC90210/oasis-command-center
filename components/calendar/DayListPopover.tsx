"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { formatTime, sameDay, weekdayShort } from "@/lib/calendar/dates";
import type { CalendarRecord, Occurrence } from "@/lib/calendar/types";
import { hueOf, placeBeside, useDialogFocus, useOutsidePress, type Anchor } from "./ui";

type Props = {
  day: Date;
  anchor: Anchor | null;
  occurrences: Occurrence[];
  calendars: Map<string, CalendarRecord>;
  now: Date;
  onOpen: (occ: Occurrence, el: HTMLElement) => void;
  onClose: () => void;
};

export function DayListPopover({ day, anchor, occurrences, calendars, now, onOpen, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  useOutsidePress(ref, onClose);
  const pos = placeBeside(anchor, 240, 320);
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const list = occurrences.filter((o) => o.start < next && o.end > day);
  return (
    <div ref={ref} role="dialog" aria-label={day.toDateString()} className="cal-float cal-enter fixed z-50 w-60 rounded-lg border border-hairline bg-bg-elev p-3" style={{ top: pos.top, left: pos.left }}>
      <div className="mb-2 flex items-start justify-between">
        <div className="text-center">
          <div className="text-[11px] font-medium text-fg-dim">{weekdayShort(day.getDay())}</div>
          <div className="daynum text-xl" data-today={sameDay(day, now)}>{day.getDate()}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-y-auto">
        {list.map((o) => (
          <li key={o.key}>
            <button
              type="button"
              data-hue={hueOf(o, calendars)}
              className={`${o.allDay ? "pill" : "dotline"} flex w-full items-center gap-1.5 truncate px-1.5 py-0.5 text-left text-[12px]`}
              onClick={(e) => onOpen(o, e.currentTarget)}
            >
              {!o.allDay && <span className="swatch h-2 w-2 shrink-0 rounded-full" aria-hidden />}
              {!o.allDay && <span className="shrink-0 text-fg-muted">{formatTime(o.start)}</span>}
              <span className="truncate">{o.event.title || "(No title)"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
