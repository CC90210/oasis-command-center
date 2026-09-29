"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Repeat2 } from "lucide-react";
import {
  DAY_MINUTES,
  addDays,
  atMinute,
  formatHourLabel,
  formatTime,
  formatTimeRange,
  minutesIntoDay,
  sameDay,
  snap,
  weekdayShort,
} from "@/lib/calendar/dates";
import { layoutDay, layoutSpans } from "@/lib/calendar/layout";
import { shabbatWindows, sunTimes } from "@/lib/calendar/sun";
import type { CalendarPrefs, CalendarRecord, Occurrence } from "@/lib/calendar/types";
import { anchorOf, hueOf, type Anchor } from "./ui";

const HOUR = 48;
const SNAP = 15;
const ALLDAY_ROWS = 3;
const DAY_MS = 86_400_000;

type Drag =
  | { mode: "create"; dayIdx: number; fromMin: number; toMin: number; moved: boolean; x: number; y: number }
  | { mode: "move" | "resize"; occ: Occurrence; /** ms from the event's true start to the grab point */ grabOffset: number; dayIdx: number; min: number; moved: boolean; x: number; y: number; originDayIdx: number };

export type TimeGridProps = {
  days: Date[];
  occurrences: Occurrence[];
  calendars: Map<string, CalendarRecord>;
  prefs: CalendarPrefs;
  now: Date;
  selectedKey: string | null;
  onOpen: (occ: Occurrence, el: HTMLElement) => void;
  onCreate: (start: Date, end: Date, allDay: boolean, anchor: Anchor | null) => void;
  onMove: (occ: Occurrence, start: Date, end: Date) => void;
  onPickDay: (day: Date) => void;
  /** A panel is open: a press on empty grid only dismisses it, as in Google Calendar. */
  suppressCreate?: boolean;
};

const isLong = (o: Occurrence) => o.allDay || o.end.getTime() - o.start.getTime() >= DAY_MS;

export function TimeGrid({ days, occurrences, calendars, prefs, now, selectedKey, onOpen, onCreate, onMove, onPickDay, suppressCreate }: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [showAllDay, setShowAllDay] = useState(false);
  // A drag ends with a click on the same element; that click must not open it.
  const suppressClick = useRef(false);
  const open = (occ: Occurrence, el: HTMLElement) => {
    if (suppressClick.current) return;
    onOpen(occ, el);
  };

  const first = days[0];
  const rangeEnd = addDays(days[days.length - 1], 1);
  const timed = useMemo(() => occurrences.filter((o) => !isLong(o)), [occurrences]);
  const spans = useMemo(() => layoutSpans(days, occurrences.filter(isLong), true), [days, occurrences]);
  const spanRows = spans.reduce((m, s) => Math.max(m, s.row + 1), 0);
  const visibleRows = showAllDay ? spanRows : Math.min(spanRows, ALLDAY_ROWS);
  const perDay = useMemo(() => days.map((d) => layoutDay(d, timed)), [days, timed]);
  const shabbat = useMemo(
    () => (prefs.shabbatProtection ? shabbatWindows(first, rangeEnd, prefs) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [first.getTime(), rangeEnd.getTime(), prefs],
  );
  const sky = useMemo(() => days.map((d) => sunTimes(d, prefs.location.lat, prefs.location.lon)), [days, prefs.location]);

  // Open on the working morning, or an hour before now when today is shown.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const today = days.some((d) => sameDay(d, now));
    const minute = today ? Math.max(0, minutesIntoDay(now) - 90) : 7 * 60;
    el.scrollTop = (minute / 60) * HOUR;
    // Only when the visible range changes, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.getTime(), days.length]);

  const locate = (clientX: number, clientY: number) => {
    const rect = colsRef.current!.getBoundingClientRect();
    const colW = rect.width / days.length;
    const dayIdx = Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left) / colW)));
    const raw = ((clientY - rect.top) / HOUR) * 60;
    return { dayIdx, min: Math.max(0, Math.min(DAY_MINUTES, raw)) };
  };

  useEffect(() => {
    if (!drag) return;
    const onMovePtr = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4;
      const { dayIdx, min } = locate(e.clientX, e.clientY);
      if (d.mode === "create") setDrag({ ...d, moved, toMin: snap(min, SNAP), dayIdx: d.dayIdx });
      else setDrag({ ...d, moved, dayIdx: d.mode === "resize" ? d.originDayIdx : dayIdx, min: snap(min, SNAP) });
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.moved) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
      const at: Anchor = { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX };
      if (d.mode === "create") {
        const day = days[d.dayIdx];
        if (!d.moved) {
          const start = atMinute(day, Math.min(DAY_MINUTES - 30, Math.floor(d.fromMin / 30) * 30));
          onCreate(start, new Date(start.getTime() + prefs.defaultDurationMin * 60_000), false, at);
          return;
        }
        const a = Math.min(d.fromMin, d.toMin);
        const b = Math.max(d.fromMin, d.toMin);
        onCreate(atMinute(day, a), atMinute(day, Math.max(b, a + SNAP)), false, at);
        return;
      }
      if (!d.moved) return;
      const preview = previewOf(d);
      if (preview) onMove(d.occ, preview.start, preview.end);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrag(null);
    };
    window.addEventListener("pointermove", onMovePtr);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMovePtr);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
    // The handlers read the live drag from a ref; re-binding per move is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const previewOf = (d: Drag) => {
    if (d.mode === "create") return null;
    const duration = d.occ.end.getTime() - d.occ.start.getTime();
    if (d.mode === "move") {
      // Measured from the event's real start, so grabbing the second-day
      // segment of an overnight event keeps its previous-day portion.
      const start = new Date(atMinute(days[d.dayIdx], Math.min(DAY_MINUTES, d.min)).getTime() - d.grabOffset);
      return { start, end: new Date(start.getTime() + duration) };
    }
    // The end is on the day of the segment being dragged (an overnight event
    // is resized from its second day), and never earlier than start + 15 min.
    const end = atMinute(days[d.originDayIdx], d.min);
    const floor = d.occ.start.getTime() + SNAP * 60_000;
    return { start: d.occ.start, end: end.getTime() < floor ? new Date(floor) : end };
  };

  const beginCreate = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget || suppressCreate) return;
    const { dayIdx, min } = locate(e.clientX, e.clientY);
    const m = snap(min, SNAP);
    setDrag({ mode: "create", dayIdx, fromMin: m, toMin: m + SNAP, moved: false, x: e.clientX, y: e.clientY });
  };

  const beginMove = (e: ReactPointerEvent, occ: Occurrence, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { dayIdx, min } = locate(e.clientX, e.clientY);
    setDrag({ mode, occ, grabOffset: atMinute(days[dayIdx], snap(min, SNAP)).getTime() - occ.start.getTime(), dayIdx, originDayIdx: dayIdx, min: snap(min, SNAP), moved: false, x: e.clientX, y: e.clientY });
  };

  const moving = drag && drag.mode !== "create" && drag.moved ? drag : null;
  const preview = moving ? previewOf(moving) : null;
  const cols = `repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Day headers */}
      <div className="grid shrink-0 border-b border-hairline" style={{ gridTemplateColumns: `var(--cal-gutter) ${cols}` }}>
        <div className="self-end pb-1 pr-2 text-right text-[10px] text-fg-dim">{gmtLabel()}</div>
        {days.map((d) => {
          const today = sameDay(d, now);
          return (
            <div key={d.toISOString()} className="flex flex-col items-center gap-1 border-l border-hairline py-2">
              <span className={`text-[11px] font-medium ${today ? "text-accent" : "text-fg-dim"}`}>{weekdayShort(d.getDay())}</span>
              <button type="button" onClick={() => onPickDay(d)} className="daynum text-lg hover:bg-bg-hover" data-today={today} aria-label={`Open ${d.toDateString()}`}>
                {d.getDate()}
              </button>
            </div>
          );
        })}
      </div>

      {/* All-day strip */}
      <div className="grid shrink-0 border-b border-hairline" style={{ gridTemplateColumns: `var(--cal-gutter) ${cols}` }}>
        <div className="flex items-start justify-end px-2 py-1">
          {spanRows > ALLDAY_ROWS && (
            <button type="button" className="text-[11px] text-fg-dim hover:text-fg" onClick={() => setShowAllDay((v) => !v)} aria-expanded={showAllDay}>
              {showAllDay ? "Less" : `+${spanRows - ALLDAY_ROWS}`}
            </button>
          )}
        </div>
        <div className="relative col-span-full col-start-2 grid" style={{ gridTemplateColumns: cols, minHeight: Math.max(1, visibleRows) * 22 + 8 }}>
          {days.map((d, i) => (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              aria-label={`Create an all-day event on ${d.toDateString()}`}
              className="border-l border-hairline hover:bg-bg-hover/40"
              onClick={(e) => onCreate(d, addDays(d, 1), true, anchorOf(e.currentTarget))}
            />
          ))}
          {spans
            .filter((s) => s.row < visibleRows)
            .map((s) => (
              <button
                key={`${s.occ.key}`}
                type="button"
                data-hue={hueOf(s.occ, calendars)}
                data-selected={selectedKey === s.occ.key}
                onClick={(e) => open(s.occ, e.currentTarget)}
                className="pill absolute truncate px-2 text-left text-[12px] font-medium leading-5"
                style={{
                  top: 4 + s.row * 22,
                  height: 20,
                  left: `calc(${(s.startCol / days.length) * 100}% + 2px)`,
                  width: `calc(${(s.span / days.length) * 100}% - 4px)`,
                  borderTopLeftRadius: s.continuesBefore ? 0 : undefined,
                  borderBottomLeftRadius: s.continuesBefore ? 0 : undefined,
                  borderTopRightRadius: s.continuesAfter ? 0 : undefined,
                  borderBottomRightRadius: s.continuesAfter ? 0 : undefined,
                }}
                title={s.occ.event.title || "(No title)"}
              >
                {!s.occ.allDay && <span className="mr-1 text-fg-muted">{formatTime(s.occ.start)}</span>}
                {s.occ.event.title || "(No title)"}
              </button>
            ))}
        </div>
      </div>

      {/* Hours */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="grid" style={{ gridTemplateColumns: `var(--cal-gutter) ${cols}`, height: 24 * HOUR }}>
          <div className="relative select-none" aria-hidden>
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-2 -translate-y-1/2 text-[10px] text-fg-dim" style={{ top: (i + 1) * HOUR }}>
                {formatHourLabel(i + 1)}
              </span>
            ))}
            {days.some((d) => sameDay(d, now)) && (
              <span className="absolute right-1 z-10 -translate-y-1/2 rounded bg-bg px-1 text-[10px] font-semibold" style={{ top: (minutesIntoDay(now) / 60) * HOUR, color: "var(--cal-now)" }}>
                {formatTime(now)}
              </span>
            )}
          </div>

          <div ref={colsRef} className="relative col-span-full col-start-2 grid" style={{ gridTemplateColumns: cols }}>
            {days.map((day, i) => {
              const s = sky[i];
              const today = sameDay(day, now);
              return (
                <div
                  key={day.toISOString()}
                  className="relative border-l border-hairline"
                  style={{ background: skyBackground(s.sunrise, s.sunset, day) }}
                  onPointerDown={beginCreate}
                >
                  {s.sunrise && <div className="horizon-line" style={{ top: (minutesIntoDay(s.sunrise) / 60) * HOUR }} title={`Sunrise ${formatTime(s.sunrise)}`} />}
                  {s.sunset && <div className="horizon-line" style={{ top: (minutesIntoDay(s.sunset) / 60) * HOUR }} title={`Sunset ${formatTime(s.sunset)}`} />}

                  {shabbat
                    .filter((w) => w.start < addDays(day, 1) && w.end > day)
                    .map((w) => {
                      const top = w.start > day ? minutesIntoDay(w.start) : 0;
                      const bottom = w.end < addDays(day, 1) ? minutesIntoDay(w.end) : DAY_MINUTES;
                      const startsHere = w.start > day;
                      const endsHere = w.end < addDays(day, 1);
                      return (
                        <div key={w.start.toISOString()} className="protected" style={{ top: (top / 60) * HOUR, height: ((bottom - top) / 60) * HOUR, borderTopWidth: startsHere ? 1 : 0, borderBottomWidth: endsHere ? 1 : 0 }}>
                          {startsHere && <span className="protected-label absolute inset-x-1.5 top-1 truncate text-[10px] font-medium">Shabbat · candles {formatTime(w.start)}</span>}
                          {endsHere && <span className="protected-label absolute inset-x-1.5 bottom-1 truncate text-[10px] font-medium">Ends {formatTime(w.end)}</span>}
                        </div>
                      );
                    })}

                  {perDay[i].map((p) => {
                    const isSource = moving?.occ.key === p.occ.key;
                    return (
                      <EventBlock
                        key={p.occ.key}
                        occ={p.occ}
                        hue={hueOf(p.occ, calendars)}
                        top={(p.top / 60) * HOUR}
                        height={((p.bottom - p.top) / 60) * HOUR}
                        left={p.left}
                        width={p.width}
                        now={now}
                        selected={selectedKey === p.occ.key}
                        dragging={isSource}
                        onOpen={open}
                        onGrab={(e, mode) => beginMove(e, p.occ, mode)}
                        resizable={!p.continuesAfter}
                      />
                    );
                  })}

                  {moving && preview && preview.start < addDays(day, 1) && preview.end > day && (
                    <EventBlock
                      occ={{ ...moving.occ, start: preview.start, end: preview.end }}
                      hue={hueOf(moving.occ, calendars)}
                      top={((preview.start > day ? minutesIntoDay(preview.start) : 0) / 60) * HOUR}
                      height={Math.max(20, (((preview.end < addDays(day, 1) ? minutesIntoDay(preview.end) || DAY_MINUTES : DAY_MINUTES) - (preview.start > day ? minutesIntoDay(preview.start) : 0)) / 60) * HOUR)}
                      left={0}
                      width={1}
                      now={now}
                      ghost
                    />
                  )}

                  {drag?.mode === "create" && drag.moved && drag.dayIdx === i && (
                    <div className="chip pointer-events-none absolute inset-x-1 z-40 px-2 py-1 text-[12px] font-medium" data-hue="tide" style={{ top: (Math.min(drag.fromMin, drag.toMin) / 60) * HOUR, height: Math.max(SNAP, Math.abs(drag.toMin - drag.fromMin)) / 60 * HOUR }}>
                      {formatTimeRange(atMinute(day, Math.min(drag.fromMin, drag.toMin)), atMinute(day, Math.max(drag.fromMin, drag.toMin, Math.min(drag.fromMin, drag.toMin) + SNAP)))}
                    </div>
                  )}

                  {today && <div className="now-line" style={{ top: (minutesIntoDay(now) / 60) * HOUR }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function gmtLabel(): string {
  const off = -new Date().getTimezoneOffset();
  const h = Math.trunc(off / 60);
  const m = Math.abs(off % 60);
  return `GMT${h >= 0 ? "+" : ""}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** Night below, day on the canvas, a 40-minute twilight at each horizon. Hour lines on top. */
function skyBackground(sunrise: Date | null, sunset: Date | null, day: Date): string {
  const lines = `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR - 1}px, rgb(var(--c-hairline)) ${HOUR - 1}px, rgb(var(--c-hairline)) ${HOUR}px)`;
  if (!sunrise || !sunset || !sameDay(sunrise, day)) return `${lines}, var(--cal-day)`;
  const pct = (d: Date, shift: number) => `${Math.max(0, Math.min(100, ((minutesIntoDay(d) + shift) / DAY_MINUTES) * 100)).toFixed(2)}%`;
  const sky = `linear-gradient(to bottom, var(--cal-night) ${pct(sunrise, -20)}, var(--cal-day) ${pct(sunrise, 20)}, var(--cal-day) ${pct(sunset, -20)}, var(--cal-night) ${pct(sunset, 20)})`;
  return `${lines}, ${sky}`;
}

type BlockProps = {
  occ: Occurrence;
  hue: string;
  top: number;
  height: number;
  left: number;
  width: number;
  now: Date;
  selected?: boolean;
  dragging?: boolean;
  ghost?: boolean;
  resizable?: boolean;
  onOpen?: (occ: Occurrence, el: HTMLElement) => void;
  onGrab?: (e: ReactPointerEvent, mode: "move" | "resize") => void;
};

function EventBlock({ occ, hue, top, height, left, width, now, selected, dragging, ghost, resizable, onOpen, onGrab }: BlockProps) {
  const title = occ.event.title || "(No title)";
  const compact = height < 34;
  const time = formatTimeRange(occ.start, occ.end);
  const label = `${title}, ${time}${occ.event.location ? `, ${occ.event.location}` : ""}${occ.master ? ", repeating" : ""}`;
  return (
    <div
      role={ghost ? undefined : "button"}
      tabIndex={ghost ? -1 : 0}
      aria-label={ghost ? undefined : label}
      data-hue={hue}
      data-selected={selected}
      data-ghost={ghost}
      data-dragging-source={dragging}
      data-free={!occ.event.busy}
      data-past={occ.end < now}
      className={`chip absolute overflow-hidden px-1.5 text-left ${ghost ? "pointer-events-none" : "cursor-pointer"}`}
      style={{ top: top + 1, height: Math.max(18, height - 2), left: `calc(${left * 100}% + 2px)`, width: `calc(${width * 100}% - ${width < 1 ? 3 : 6}px)` }}
      onPointerDown={(e) => onGrab?.(e, "move")}
      onClick={(e) => {
        if (!ghost) onOpen?.(occ, e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(occ, e.currentTarget);
        }
      }}
    >
      {compact ? (
        <div className="truncate text-[11px] leading-4 pt-px">
          <span className="font-semibold">{title}</span>
          <span className="text-fg-muted">, {formatTime(occ.start)}</span>
        </div>
      ) : (
        <div className="pt-0.5">
          <div className="flex items-start gap-1">
            <span className="line-clamp-2 text-[12px] font-semibold leading-4">{title}</span>
            {occ.master && <Repeat2 className="mt-0.5 h-3 w-3 shrink-0 opacity-60" aria-hidden />}
          </div>
          <div className="truncate text-[11px] leading-4 text-fg-muted">{time}</div>
          {occ.event.location && height > 64 && <div className="truncate text-[11px] leading-4 text-fg-muted">{occ.event.location}</div>}
        </div>
      )}
      {resizable && onGrab && (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
          onPointerDown={(e) => onGrab(e, "resize")}
        />
      )}
    </div>
  );
}
