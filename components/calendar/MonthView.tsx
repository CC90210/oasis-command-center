"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, formatTime, monthMatrix, monthShort, sameDay, startOfDay, weekdayShort } from "@/lib/calendar/dates";
import { layoutSpans } from "@/lib/calendar/layout";
import { shabbatWindows } from "@/lib/calendar/sun";
import type { CalendarPrefs, CalendarRecord, Occurrence } from "@/lib/calendar/types";
import { anchorOf, hueOf, type Anchor } from "./ui";

const ROW_H = 22;
const HEAD_H = 30;

type Props = {
  anchor: Date;
  occurrences: Occurrence[];
  calendars: Map<string, CalendarRecord>;
  prefs: CalendarPrefs;
  now: Date;
  selectedKey: string | null;
  onOpen: (occ: Occurrence, el: HTMLElement) => void;
  onCreate: (start: Date, end: Date, allDay: boolean, anchor: Anchor | null) => void;
  onMoveToDay: (occ: Occurrence, day: Date) => void;
  onPickDay: (day: Date) => void;
  onShowMore: (day: Date, el: HTMLElement) => void;
  /** A panel is open: a press on an empty day only dismisses it. */
  suppressCreate?: boolean;
};

export function MonthView({ anchor, occurrences, calendars, prefs, now, selectedKey, onOpen, onCreate, onMoveToDay, onPickDay, onShowMore, suppressCreate }: Props) {
  const weeks = useMemo(() => monthMatrix(anchor, prefs.weekStartsOn), [anchor, prefs.weekStartsOn]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(3);
  const [drag, setDrag] = useState<{ key: string; x: number; y: number; moved: boolean } | null>(null);
  const [overDay, setOverDay] = useState<number | null>(null);
  const suppressClick = useRef(false);
  // Read at press time: by click time the outside-press has already closed the panel.
  const createArmed = useRef(true);
  const dragKey = drag?.moved ? drag.key : null;

  // Drag an event to another day: hit-test the pointer against the 7x6 grid,
  // so dropping onto another event's pill still lands on the right day.
  useEffect(() => {
    if (!drag) return;
    const cellAt = (x: number, y: number) => {
      const r = bodyRef.current?.getBoundingClientRect();
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const col = Math.min(6, Math.floor(((x - r.left) / r.width) * 7));
      const row = Math.min(5, Math.floor(((y - r.top) / r.height) * 6));
      return row * 7 + col;
    };
    const onMove = (e: PointerEvent) => {
      const moved = drag.moved || Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4;
      if (moved !== drag.moved) setDrag({ ...drag, moved });
      if (moved) setOverDay(cellAt(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const cell = drag.moved ? cellAt(e.clientX, e.clientY) : null;
      setDrag(null);
      setOverDay(null);
      if (!drag.moved) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const occ = occurrences.find((o) => o.key === drag.key);
      if (cell === null || !occ) return;
      const day = weeks[Math.floor(cell / 7)][cell % 7];
      if (!sameDay(occ.start, day)) onMoveToDay(occ, day);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrag(null);
        setOverDay(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [drag, occurrences, weeks, onMoveToDay]);

  // How many event rows fit in a cell, recomputed as the window resizes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rowH = el.clientHeight / 6;
      setCapacity(Math.max(1, Math.floor((rowH - HEAD_H) / ROW_H)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shabbatDays = useMemo(() => {
    const set = new Set<number>();
    if (!prefs.shabbatProtection) return set;
    const first = weeks[0][0];
    for (const w of shabbatWindows(first, addDays(first, 42), prefs)) {
      set.add(startOfDay(w.start).getTime());
      set.add(startOfDay(w.end).getTime());
    }
    return set;
  }, [weeks, prefs]);

  const month = anchor.getMonth();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-hairline">
        {weeks[0].map((d) => (
          <div key={d.getDay()} className="py-2 text-center text-[11px] font-medium text-fg-dim">
            {weekdayShort(d.getDay())}
          </div>
        ))}
      </div>
      <div ref={bodyRef} className="grid min-h-0 flex-1 grid-rows-6">
        {weeks.map((week, wi) => {
          const segs = layoutSpans(week, occurrences, true);
          // Rows each day needs; only a day that needs MORE than fit gives up
          // its last row to the "N more" link. A day that exactly fits shows all.
          const need = week.map(() => 0);
          for (const s of segs) for (let c = s.startCol; c < s.startCol + s.span; c++) need[c] = Math.max(need[c], s.row + 1);
          const rowsFor = (col: number) => (need[col] > capacity ? capacity - 1 : capacity);
          const hidden = week.map((_, c) => segs.filter((s) => s.startCol <= c && c < s.startCol + s.span && s.row >= rowsFor(c)).length);
          // A bar is drawn in runs over the days where its row fits, so a
          // neighbour's overflow never hides it from a day that has room.
          const pieces = segs.flatMap((s) => {
            const runs: { s: typeof s; from: number; to: number }[] = [];
            for (let c = s.startCol; c < s.startCol + s.span; c++) {
              if (s.row >= rowsFor(c)) continue;
              const last = runs[runs.length - 1];
              if (last && last.to === c - 1) last.to = c;
              else runs.push({ s, from: c, to: c });
            }
            return runs;
          });
          return (
            <div key={wi} className="relative grid grid-cols-7 border-b border-hairline last:border-b-0">
              {week.map((day, di) => {
                const inMonth = day.getMonth() === month;
                const today = sameDay(day, now);
                const cellIdx = wi * 7 + di;
                return (
                  <div
                    key={di}
                    className={`relative min-w-0 border-l border-hairline first:border-l-0 ${inMonth ? "" : "bg-bg-deep/60"} ${overDay === cellIdx ? "bg-accent/10" : ""}`}
                    onPointerDown={() => (createArmed.current = !suppressCreate)}
                    onClick={(e) => {
                      if (e.target === e.currentTarget && createArmed.current) onCreate(day, addDays(day, 1), true, { ...anchorOf(e.currentTarget)! });
                    }}
                  >
                    <div className="pointer-events-none flex items-center justify-center pt-1" style={{ height: HEAD_H }}>
                      <button
                        type="button"
                        className="daynum pointer-events-auto h-6 min-w-6 text-[12px] hover:bg-bg-hover"
                        data-today={today}
                        onClick={() => onPickDay(day)}
                        aria-label={`Open ${day.toDateString()}`}
                      >
                        <span className={inMonth || today ? "" : "text-fg-dim"}>{day.getDate() === 1 ? `${monthShort(day.getMonth())} 1` : day.getDate()}</span>
                      </button>
                      {shabbatDays.has(day.getTime()) && (
                        <span className="protected-mark absolute right-2 top-2.5" title="Shabbat (protected time)" role="img" aria-label="Shabbat" />
                      )}
                    </div>
                    {hidden[di] > 0 && (
                      <button
                        type="button"
                        className="absolute inset-x-1 rounded px-1.5 text-left text-[11px] font-medium text-fg-muted hover:bg-bg-hover hover:text-fg"
                        style={{ top: HEAD_H + (capacity - 1) * ROW_H, height: ROW_H - 2 }}
                        onClick={(e) => onShowMore(day, e.currentTarget)}
                      >
                        {hidden[di]} more
                      </button>
                    )}
                  </div>
                );
              })}
              {pieces.map(({ s, from, to }) => {
                const bar = s.occ.allDay || s.span > 1;
                const hue = hueOf(s.occ, calendars);
                const title = s.occ.event.title || "(No title)";
                return (
                  <button
                    key={`${s.occ.key}:${from}`}
                    type="button"
                    data-hue={hue}
                    data-selected={selectedKey === s.occ.key}
                    className={`${bar ? "pill" : "dotline"} absolute flex items-center gap-1.5 truncate px-1.5 text-left text-[12px] leading-5 ${dragKey === s.occ.key ? "opacity-40" : ""}`}
                    style={{
                      top: HEAD_H + s.row * ROW_H,
                      height: ROW_H - 2,
                      left: `calc(${(from / 7) * 100}% + 3px)`,
                      width: `calc(${((to - from + 1) / 7) * 100}% - 6px)`,
                    }}
                    title={title}
                    onPointerDown={(e) => {
                      if (e.button === 0) setDrag({ key: s.occ.key, x: e.clientX, y: e.clientY, moved: false });
                    }}
                    onClick={(e) => {
                      if (!suppressClick.current) onOpen(s.occ, e.currentTarget);
                    }}
                  >
                    {!bar && <span className="swatch h-2 w-2 shrink-0 rounded-full" aria-hidden />}
                    {!s.occ.allDay && <span className={bar ? "text-fg-muted" : "shrink-0 text-fg-muted"}>{formatTime(s.occ.start)}</span>}
                    <span className={`truncate ${bar ? "font-medium" : ""}`}>{title}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
