"use client";

import { useMemo } from "react";
import { startOfDay } from "@/lib/calendar/dates";
import type { Occurrence } from "@/lib/calendar/types";
import { MiniMonth } from "./MiniMonth";

type Props = {
  year: number;
  occurrences: Occurrence[];
  now: Date;
  weekStartsOn: number;
  onPickDay: (day: Date) => void;
};

export function YearView({ year, occurrences, now, weekStartsOn, onPickDay }: Props) {
  const busy = useMemo(() => {
    const set = new Set<number>();
    for (const o of occurrences) {
      for (let d = startOfDay(o.start); d < o.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) set.add(d.getTime());
    }
    return set;
  }, [occurrences]);
  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 12 }, (_, m) => (
          <MiniMonth
            key={m}
            month={new Date(year, m, 1)}
            selected={now}
            now={now}
            weekStartsOn={weekStartsOn}
            busyDays={busy}
            onPick={onPickDay}
            compact
          />
        ))}
      </div>
    </div>
  );
}
