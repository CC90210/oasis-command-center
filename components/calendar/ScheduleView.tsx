"use client";

import { useMemo } from "react";
import { MapPin, Repeat2 } from "lucide-react";
import { addDays, formatTime, formatTimeRange, monthShort, sameDay, startOfDay, weekdayShort } from "@/lib/calendar/dates";
import type { CalendarRecord, Occurrence } from "@/lib/calendar/types";
import { hueOf } from "./ui";

type Props = {
  occurrences: Occurrence[];
  calendars: Map<string, CalendarRecord>;
  now: Date;
  selectedKey: string | null;
  onOpen: (occ: Occurrence, el: HTMLElement) => void;
  onPickDay: (day: Date) => void;
  /** Shown above the list, e.g. "12 results for 'standup'". */
  heading?: string;
  emptyText: string;
};

/** The agenda: one row per day that has something on it. Also renders search results. */
export function ScheduleView({ occurrences, calendars, now, selectedKey, onOpen, onPickDay, heading, emptyText }: Props) {
  const groups = useMemo(() => {
    const map = new Map<number, Occurrence[]>();
    for (const o of occurrences) {
      // A multi-day event is listed on each day it covers.
      const last = new Date(o.end.getTime() - 1);
      for (let d = startOfDay(o.start); d <= last; d = addDays(d, 1)) {
        const k = d.getTime();
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(o);
        if (map.size > 400) break;
      }
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [occurrences]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-4 md:px-8">
        {heading && <h2 className="mb-3 text-sm font-medium text-fg-muted">{heading}</h2>}
        {groups.length === 0 ? (
          <p className="py-16 text-center text-sm text-fg-muted">{emptyText}</p>
        ) : (
          <ol className="divide-y divide-hairline">
            {groups.map(([k, list]) => {
              const day = new Date(k);
              const today = sameDay(day, now);
              return (
                <li key={k} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-4">
                  <button type="button" onClick={() => onPickDay(day)} className="flex items-start gap-2 self-start rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <span className="daynum text-base" data-today={today}>{day.getDate()}</span>
                    <span className={`pt-1.5 text-[11px] font-medium ${today ? "text-accent" : "text-fg-dim"}`}>
                      {monthShort(day.getMonth())}, {weekdayShort(day.getDay())}
                    </span>
                  </button>
                  <ul className="space-y-0.5">
                    {list.map((o) => {
                      const title = o.event.title || "(No title)";
                      return (
                        <li key={o.key}>
                          <button
                            type="button"
                            data-hue={hueOf(o, calendars)}
                            data-selected={selectedKey === o.key}
                            onClick={(e) => onOpen(o, e.currentTarget)}
                            className={`dotline grid w-full grid-cols-[12px_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 px-2 py-2 text-left text-[13px] sm:grid-cols-[12px_128px_minmax(0,1fr)] sm:items-center sm:gap-3 sm:py-1.5 ${o.end < now ? "text-fg-muted" : "text-fg"}`}
                          >
                            <span className="swatch col-start-1 row-start-1 mt-1 h-2.5 w-2.5 rounded-full sm:mt-0" aria-hidden />
                            <span className="col-start-2 row-start-2 truncate text-[12px] text-fg-muted sm:row-start-1 sm:text-[13px]">{o.allDay || !sameDay(o.start, new Date(o.end.getTime() - 1)) ? spanLabel(o, day) : formatTimeRange(o.start, o.end)}</span>
                            <span className="col-start-2 row-start-1 flex min-w-0 items-start gap-2 sm:col-start-3 sm:items-center">
                              <span className="min-w-0 break-words font-medium sm:truncate">{title}</span>
                              {o.master && <Repeat2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-dim sm:mt-0" aria-label="Repeats" />}
                              {o.event.location && (
                                <span className="hidden min-w-0 items-center gap-1 truncate text-[12px] text-fg-muted md:flex">
                                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                  <span className="truncate">{o.event.location}</span>
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function spanLabel(o: Occurrence, day: Date): string {
  if (o.allDay) return "All day";
  if (sameDay(o.start, day)) return `From ${formatTime(o.start)}`;
  if (sameDay(new Date(o.end.getTime() - 1), day)) return `Until ${formatTime(o.end)}`;
  return "All day";
}
