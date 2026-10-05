/**
 * One-time import of the old browser-only weekly schedule (lib/schedule/model.ts)
 * into real, repeating calendar events.
 *
 * The old page saved a template week per browser under `oasis.schedule.*`.
 * Each editable block becomes a weekly series on its weekday, starting the
 * week it was saved. System Shabbat blocks are skipped: Shabbat is now
 * computed from the sunset, not stored. A "Work" container whose children
 * were shown instead of it is skipped the same way the old page hid it.
 *
 * Near Shabbat each series goes through the same splitter the routine restore
 * uses (routine.ts planAroundShabbat): a winter Friday afternoon is shortened
 * to end before candle-lighting, or left out that week, instead of the whole
 * block being dropped because some Fridays collide.
 */

import { DAYS, isScheduleDocument, type ScheduleDocument } from "@/lib/schedule/model";
import { addDays, atMinute, fromDateKey, isDateKey } from "./dates";
import { BLOCK_HUE, planAroundShabbat, ROUTINE_ID_PREFIX } from "./routine";
import type { CalendarPrefs, EventInput, EventOp, EventRecord } from "./types";
import { LIMITS, shabbatConflict } from "./validate";

export const LEGACY_KEY_PREFIX = "oasis.schedule";

/** The most recently saved week among the raw localStorage values given. */
export function pickLegacyWeek(raw: (string | null)[]): ScheduleDocument | null {
  let best: ScheduleDocument | null = null;
  for (const text of raw) {
    if (!text) continue;
    try {
      const doc: unknown = JSON.parse(text);
      if (!isScheduleDocument(doc) || !isDateKey(doc.weekStartsOn)) continue;
      if (!best || doc.updatedAt > best.updatedAt) best = doc;
    } catch {
      /* A corrupt entry is skipped, never fatal. */
    }
  }
  return best;
}

export type LegacyPlan = {
  events: EventInput[];
  /** Blocks with no week left: every one fell inside Shabbat. */
  skippedForShabbat: string[];
  /** Blocks shortened or left out on the weeks that meet Shabbat. */
  adjustedForShabbat: string[];
};

export function planLegacyImport(doc: ScheduleDocument, calendarId: string, timeZone: string, prefs: CalendarPrefs): LegacyPlan {
  const monday = fromDateKey(doc.weekStartsOn);
  const parents = new Set(doc.blocks.filter((b) => b.parentId).map((b) => b.parentId!));
  const events: EventInput[] = [];
  const skippedForShabbat: string[] = [];
  const adjustedForShabbat: string[] = [];
  for (const b of doc.blocks) {
    if (b.system || b.locked || parents.has(b.id)) continue;
    const day = addDays(monday, DAYS.indexOf(b.day));
    const start = atMinute(day, b.startMinute);
    const end = atMinute(day, Math.min(b.endMinute, 24 * 60));
    if (!(end > start)) continue;
    const input: EventInput = {
      calendarId,
      title: b.title.slice(0, 300),
      description: (b.description ?? "").slice(0, 8000),
      location: "",
      allDay: false,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone,
      recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [day.getDay()] },
      exdates: [],
      recurringEventId: null,
      originalStart: null,
      color: BLOCK_HUE[b.category] ?? null,
      reminders: [],
      guests: [],
      busy: true,
    };
    const split = planAroundShabbat(input, prefs);
    // What the server would still refuse is named and left out, never sent.
    const planned = [...(split.series ? [split.series] : []), ...split.singles].filter((e) => !shabbatConflict(e, prefs));
    if (!planned.length) skippedForShabbat.push(`${b.day} ${b.title}`);
    else {
      events.push(...planned);
      if (split.through) adjustedForShabbat.push(`${b.day} ${b.title}`);
    }
  }
  return { events, skippedForShabbat, adjustedForShabbat };
}

/**
 * The rows a routine restore wrote (routine.ts ROUTINE_ID_PREFIX), with any
 * one-day edits made to them since (overrides point at their series).
 */
export function restoredRoutineIds(events: EventRecord[]): string[] {
  const series = new Set(events.filter((e) => e.id.startsWith(ROUTINE_ID_PREFIX)).map((e) => e.id));
  return events.filter((e) => series.has(e.id) || (e.recurringEventId !== null && series.has(e.recurringEventId))).map((e) => e.id);
}

export type LegacyWrites = {
  /** Requests to send in order; each is one POST /api/calendar/events. */
  batches: EventOp[][];
  /** Rows of the restored routine this import removes (0 when there is none). */
  replacing: number;
};

/**
 * The writes that bring the browser's old week into the calendar.
 *
 * The restore (POST /api/calendar/routine) and this import write the same
 * routine as separate rows, and nothing else links them: importing on top of
 * a restored routine put every block in twice. So when the calendar already
 * holds the restored routine, the browser's week REPLACES it: its rows are
 * deleted after the creates (the server applies a request's ops in order,
 * store.ts applyOps), so a failure part-way never leaves the calendar with
 * neither. No other row is ever touched. With nothing to import, nothing is
 * removed either.
 *
 * Everything goes in ONE request whenever it fits the server's per-request
 * limit (LIMITS.opsPerBatch; a saved week is far below it): the creates are
 * then one insert, the removal one delete, and the page can undo the whole
 * import like any other change. Split requests could land the first half and
 * not the rest, leaving the restored routine beside part of the week.
 */
export function legacyImportWrites(events: EventInput[], existing: EventRecord[], max: number = LIMITS.opsPerBatch): LegacyWrites {
  if (!events.length) return { batches: [], replacing: 0 };
  const deletes = restoredRoutineIds(existing).map((id) => ({ op: "delete" as const, id }));
  const batches: EventOp[][] = [];
  for (let i = 0; i < events.length; i += max) batches.push(events.slice(i, i + max).map((event) => ({ op: "create" as const, event })));
  const last = batches[batches.length - 1];
  if (last.length + deletes.length <= max) last.push(...deletes);
  else for (let i = 0; i < deletes.length; i += max) batches.push(deletes.slice(i, i + max));
  return { batches, replacing: deletes.length };
}
