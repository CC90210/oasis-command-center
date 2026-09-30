/**
 * Positions timed occurrences inside one day column.
 *
 * Overlapping events are grouped into clusters; inside a cluster each event
 * takes the first free column, then expands right across columns that stay
 * free for its whole span. Same result shape Google Calendar produces.
 */

import { DAY_MINUTES, addDays, diffDays, minutesIntoDay, sameDay, startOfDay } from "./dates";
import type { Occurrence } from "./types";

export type PositionedEvent = {
  occ: Occurrence;
  /** Minutes from local midnight of the column's day, clipped to the day. */
  top: number;
  bottom: number;
  /** Fractions of the column width, 0..1. */
  left: number;
  width: number;
  /** True when the event continues from the previous / into the next day. */
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/** Minimum visual height, so a 5-minute event is still clickable. */
const MIN_SPAN = 20;

export function layoutDay(day: Date, occurrences: Occurrence[]): PositionedEvent[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const items = occurrences
    .filter((o) => !o.allDay && o.start < dayEnd && o.end > dayStart)
    .map((occ) => {
      const top = occ.start <= dayStart ? 0 : minutesIntoDay(occ.start);
      const bottom = occ.end >= dayEnd ? DAY_MINUTES : minutesIntoDay(occ.end) || DAY_MINUTES;
      return {
        occ,
        top,
        bottom: Math.max(bottom, Math.min(DAY_MINUTES, top + MIN_SPAN)),
        left: 0,
        width: 1,
        continuesBefore: occ.start < dayStart,
        continuesAfter: occ.end > dayEnd,
        col: 0,
      };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  const out: PositionedEvent[] = [];
  let cluster: typeof items = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const columns: number[] = []; // bottom of the last event in each column
    for (const it of cluster) {
      let col = columns.findIndex((bottom) => bottom <= it.top);
      if (col === -1) {
        col = columns.length;
        columns.push(it.bottom);
      } else columns[col] = it.bottom;
      it.col = col;
    }
    const n = columns.length;
    for (const it of cluster) {
      // Expand into neighbouring columns that are free for this whole span.
      let span = 1;
      for (let c = it.col + 1; c < n; c++) {
        const blocked = cluster.some((o) => o.col === c && o.top < it.bottom && o.bottom > it.top);
        if (blocked) break;
        span++;
      }
      out.push({
        occ: it.occ,
        top: it.top,
        bottom: it.bottom,
        left: it.col / n,
        width: span / n,
        continuesBefore: it.continuesBefore,
        continuesAfter: it.continuesAfter,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const it of items) {
    if (it.top >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  flush();
  return out;
}

export type SpanSegment = {
  occ: Occurrence;
  /** Column index inside the visible run of days. */
  startCol: number;
  span: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/**
 * Packs all-day and multi-day events into rows across a run of consecutive
 * days (the all-day strip of the week view, or one week row of the month view).
 * Timed events that cross midnight are included when `includeMultiDayTimed`.
 */
export function layoutSpans(days: Date[], occurrences: Occurrence[], includeTimed: boolean): SpanSegment[] {
  if (!days.length) return [];
  const first = startOfDay(days[0]);
  const lastEnd = addDays(startOfDay(days[days.length - 1]), 1);
  const segs: SpanSegment[] = [];
  const rows: number[][] = []; // per row, occupied end column (exclusive) intervals
  const candidates = occurrences
    .filter((o) => o.start < lastEnd && o.end > first)
    .filter((o) => o.allDay || includeTimed || !sameDay(o.start, new Date(o.end.getTime() - 1)))
    .sort((a, b) => {
      const la = a.end.getTime() - a.start.getTime();
      const lb = b.end.getTime() - b.start.getTime();
      return a.start.getTime() - b.start.getTime() || lb - la || Number(b.allDay) - Number(a.allDay);
    });

  for (const occ of candidates) {
    const startCol = Math.max(0, diffDays(first, occ.start));
    const lastDay = new Date(occ.end.getTime() - 1);
    const endCol = Math.min(days.length - 1, diffDays(first, lastDay));
    if (endCol < startCol) continue;
    let row = 0;
    for (; ; row++) {
      rows[row] ||= [];
      const taken = rows[row];
      let free = true;
      for (let c = startCol; c <= endCol; c++) if (taken[c]) free = false;
      if (free) {
        for (let c = startCol; c <= endCol; c++) taken[c] = 1;
        break;
      }
    }
    segs.push({
      occ,
      startCol,
      span: endCol - startCol + 1,
      row,
      continuesBefore: occ.start < first,
      continuesAfter: occ.end > lastEnd,
    });
  }
  return segs;
}
