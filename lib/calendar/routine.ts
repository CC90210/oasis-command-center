/**
 * CC's weekly routine as repeating calendar events (buildRoutineSeries), and
 * the Shabbat splitter the routine and the old-browser import share
 * (planAroundShabbat).
 *
 * WHY. The old Schedule page drew this routine on every device from
 * lib/schedule/model.ts createPlaceholderSchedule and kept only edits in the
 * browser. The database calendar that replaced it (PR #486) starts empty, so
 * the routine vanished everywhere except a browser that still held a local
 * copy. POST /api/calendar/routine writes it once, as weekly series in the
 * database, for the signed-in OASIS member who clicks Restore.
 *
 * SHAPE. One weekly series per block for Sunday to Thursday and one per block
 * for Friday, in America/Toronto (Montréal). Friday is its own series because
 * its afternoon meets Shabbat in winter. Every occurrence inside the planning
 * horizon is checked against the same Shabbat window the server locks
 * (sun.ts shabbatWindows). One that would end less than SHABBAT_WIND_DOWN_MIN
 * minutes before candle-lighting is taken out of its series (an exception
 * date) and replaced by a single event ending that many minutes before
 * candle-lighting, or left out that week when under MIN_SHORTENED_MIN minutes
 * would remain. A series that needed any of that ends at the horizon, so no
 * week is ever written that was not checked, and the server's own Shabbat
 * check (validate.ts shabbatConflict) passes every row as written.
 *
 * Pure: no clock and no database. The caller passes `from` and the prefs.
 */

import { createPlaceholderSchedule, DAYS, type ScheduleBlock, type ScheduleDocument } from "@/lib/schedule/model";
import { instanceKey, seriesStarts } from "./recurrence";
import { shabbatWindows } from "./sun";
import type { CalendarColor, CalendarPrefs, EventInput, EventRecord } from "./types";
import { dayNumber, fromDayNumber, instantOf, wallDateKey, wallParts } from "./zone";

/** The routine's zone: Montréal keeps Toronto's rules. */
export const ROUTINE_TIME_ZONE = "America/Toronto";
/**
 * Tag of the rows a restore writes. calendar_events has no source column, so
 * the tag is the id prefix: every restored row's id starts with it, and a
 * second restore finds them by it (store.ts restoreRoutine).
 */
export const ROUTINE_SOURCE = "routine_v1";
export const ROUTINE_ID_PREFIX = `${ROUTINE_SOURCE}-`;
/** A block near Shabbat ends this many minutes before candle-lighting. */
export const SHABBAT_WIND_DOWN_MIN = 18;
/** Shorter than this after shortening, and the block is left out that week. */
export const MIN_SHORTENED_MIN = 15;
/** Weeks checked ahead, from the series' first week. Adjusted series end there. */
export const SHABBAT_PLAN_WEEKS = 104;

const MINUTE_MS = 60_000;
const WEEK_MS = 7 * 86_400_000;
const DESCRIPTION_MAX = 8000;

/** Calendar colour per old block category (the legacy import uses the same map). */
export const BLOCK_HUE: Record<ScheduleBlock["category"], CalendarColor> = {
  morning: "saffron",
  work: "tide",
  personal: "moss",
  observance: "sand",
};

export type RoutineBlock = {
  /** Stable across days: the block id without its day prefix ("wake-up", "work-rnd"). */
  key: string;
  title: string;
  category: ScheduleBlock["category"];
  /** Minutes after midnight, wall clock. */
  startMinute: number;
  endMinute: number;
  /** 0 = Sunday … 6 = Saturday, ascending. */
  weekdays: number[];
};

const weekdayOf = (day: ScheduleBlock["day"]) => (DAYS.indexOf(day) + 1) % 7;

function blockKey(b: ScheduleBlock): string {
  const prefix = `${b.day}-`;
  return b.id.startsWith(prefix) ? b.id.slice(prefix.length) : b.id;
}

/**
 * The blocks a person keeps, one per distinct block and time with the days it
 * repeats on. Computed Shabbat blocks, locked blocks and a container shown
 * through its children ("Work", split into three) are left out, as the old
 * page and the legacy import leave them out.
 */
export function routineBlocks(doc: ScheduleDocument = createPlaceholderSchedule()): RoutineBlock[] {
  const parents = new Set(doc.blocks.filter((b) => b.parentId).map((b) => b.parentId!));
  const groups = new Map<string, RoutineBlock>();
  for (const b of doc.blocks) {
    if (b.system || b.locked || parents.has(b.id)) continue;
    const endMinute = Math.min(b.endMinute, 24 * 60);
    if (!(endMinute > b.startMinute)) continue;
    const key = blockKey(b);
    const id = `${key}|${b.title}|${b.startMinute}|${endMinute}`;
    const wd = weekdayOf(b.day);
    const found = groups.get(id);
    if (found) {
      if (!found.weekdays.includes(wd)) found.weekdays.push(wd);
    } else {
      groups.set(id, { key, title: b.title, category: b.category, startMinute: b.startMinute, endMinute, weekdays: [wd] });
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, weekdays: [...g.weekdays].sort((a, b) => a - b) }))
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.title.localeCompare(b.title));
}

export type RoutineTimeEdit = { key: string; startMinute: number; endMinute: number };

/**
 * Applies "Edit times" from the restore card. Only the times of known blocks
 * can change: titles and days come from the routine itself, never from the
 * request. Returns an error code for anything else.
 */
export function applyRoutineTimes(
  blocks: RoutineBlock[],
  raw: unknown,
): { ok: true; value: RoutineBlock[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: blocks };
  if (!Array.isArray(raw) || raw.length > 50) return { ok: false, error: "routine_times_invalid" };
  const known = new Set(blocks.map((b) => b.key));
  const edits = new Map<string, { startMinute: number; endMinute: number }>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, error: "routine_times_invalid" };
    const { key, startMinute, endMinute } = item as Record<string, unknown>;
    if (typeof key !== "string" || !known.has(key) || edits.has(key)) return { ok: false, error: "routine_block_unknown" };
    if (
      !Number.isInteger(startMinute) || !Number.isInteger(endMinute) ||
      (startMinute as number) < 0 || (endMinute as number) > 24 * 60 || (endMinute as number) <= (startMinute as number)
    )
      return { ok: false, error: "routine_time_invalid" };
    edits.set(key, { startMinute: startMinute as number, endMinute: endMinute as number });
  }
  return { ok: true, value: blocks.map((b) => (edits.has(b.key) ? { ...b, ...edits.get(b.key)! } : b)) };
}

export type ShabbatSplit = {
  /** The series with its clashing weeks taken out; null when no week is left. */
  series: EventInput | null;
  /** Single events standing in for shortened weeks. */
  singles: EventInput[];
  /** Instance keys left out with nothing in their place. */
  skipped: string[];
  /** Last date (the event's zone) the adjusted series was planned to; null when nothing changed. */
  through: string | null;
};

function withNote(description: string, note: string): string {
  return [description, note].filter((s) => s.trim()).join("\n\n").slice(0, DESCRIPTION_MAX);
}

/**
 * Plans a weekly series around Shabbat, week by week, over `weeks` weeks.
 * Returns the base unchanged when no occurrence comes near Shabbat, when the
 * lock is off, or for an all-day or non-repeating event.
 */
export function planAroundShabbat(base: EventInput, prefs: CalendarPrefs, weeks = SHABBAT_PLAN_WEEKS): ShabbatSplit {
  const unchanged: ShabbatSplit = { series: base, singles: [], skipped: [], through: null };
  if (!prefs.shabbatProtection || base.allDay || !base.recurrence) return unchanged;
  const probe: EventRecord = { ...base, id: "probe", createdAt: "", updatedAt: "", recurringEventId: null, originalStart: null };
  const duration = Date.parse(base.end) - Date.parse(base.start);
  const horizon = Date.parse(base.start) + weeks * WEEK_MS;
  const windDown = SHABBAT_WIND_DOWN_MIN * MINUTE_MS;
  const exdates = new Set(base.exdates);
  const taken: string[] = [];
  const singles: EventInput[] = [];
  const skipped: string[] = [];
  let last: Date | null = null;
  let reachedHorizon = false;
  let kept = 0;
  for (const s of seriesStarts(probe)) {
    if (s.getTime() >= horizon) {
      reachedHorizon = true;
      break;
    }
    last = s;
    const key = instanceKey(false, s);
    if (exdates.has(key)) continue;
    const guardEnd = new Date(s.getTime() + duration + windDown);
    const hit = shabbatWindows(s, guardEnd, prefs)
      .filter((w) => w.start < guardEnd && w.end > s)
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    if (!hit) {
      kept++;
      continue;
    }
    taken.push(key);
    const cutoff = Math.floor((hit.start.getTime() - windDown) / MINUTE_MS) * MINUTE_MS;
    if (cutoff - s.getTime() >= MIN_SHORTENED_MIN * MINUTE_MS) {
      singles.push({
        ...base,
        start: s.toISOString(),
        end: new Date(cutoff).toISOString(),
        recurrence: null,
        exdates: [],
        description: withNote(base.description, `Shortened for Shabbat: ends ${SHABBAT_WIND_DOWN_MIN} minutes before candle-lighting.`),
      });
    } else skipped.push(key);
  }
  if (!taken.length || !last) return unchanged;
  const through = wallDateKey(last, base.timeZone);
  const { count: _count, ...rule } = base.recurrence;
  const series: EventInput | null =
    kept > 0
      ? {
          ...base,
          // Bounded at the last checked week: nothing past it was planned.
          recurrence: reachedHorizon ? { ...rule, until: through } : base.recurrence,
          exdates: [...exdates, ...taken],
          description: withNote(
            base.description,
            `On weeks when it would end less than ${SHABBAT_WIND_DOWN_MIN} minutes before candle-lighting, it is shortened or left out that week.`,
          ),
        }
      : null;
  return { series, singles, skipped, through };
}

export type RoutineOptions = {
  calendarId: string;
  prefs: CalendarPrefs;
  /** Any instant in the first week: every series starts on that week's Sunday or later. */
  from: Date;
  timeZone?: string;
  weeks?: number;
};

/** One planned row. `key` is stable per owner, so a restore's ids are deterministic. */
export type PlannedEvent = { key: string; event: EventInput };

export type RoutineAdjustment = { key: string; label: string; shortened: number; skipped: number; through: string };

export type RoutinePlan = {
  series: PlannedEvent[];
  singles: PlannedEvent[];
  /** Series planned around Shabbat, with how many weeks were shortened or left out. */
  adjusted: RoutineAdjustment[];
  /** Blocks with no week left at all (every one fell inside Shabbat). */
  dropped: string[];
};

const DAY_GROUPS = [
  { id: "sun-thu", label: "Sunday to Thursday", days: [0, 1, 2, 3, 4] },
  { id: "fri", label: "Friday", days: [5] },
  { id: "sat", label: "Saturday", days: [6] },
] as const;

/**
 * The routine as rows to write: Sunday-to-Thursday blocks as one weekly series
 * each, Friday blocks as their own series, planned around Shabbat.
 * `model` is the old schedule document (createPlaceholderSchedule) or the
 * blocks already read from it (routineBlocks, after applyRoutineTimes).
 */
export function buildRoutineSeries(model: ScheduleDocument | RoutineBlock[], opts: RoutineOptions): RoutinePlan {
  const blocks = Array.isArray(model) ? model : routineBlocks(model);
  const tz = opts.timeZone ?? ROUTINE_TIME_ZONE;
  const w = wallParts(opts.from, tz);
  const today = dayNumber(w.y, w.m, w.d);
  const sunday = today - fromDayNumber(today).weekday;
  const plan: RoutinePlan = { series: [], singles: [], adjusted: [], dropped: [] };
  const used = new Set<string>();
  for (const block of blocks) {
    for (const group of DAY_GROUPS) {
      const days = block.weekdays.filter((d) => (group.days as readonly number[]).includes(d));
      if (!days.length) continue;
      let key = `${group.id}:${block.key}`;
      if (used.has(key)) key = `${key}@${block.startMinute}`;
      used.add(key);
      const first = fromDayNumber(sunday + days[0]);
      const start = instantOf({ y: first.y, m: first.m, d: first.d, h: Math.floor(block.startMinute / 60), mi: block.startMinute % 60, s: 0 }, tz);
      const end = new Date(start.getTime() + (block.endMinute - block.startMinute) * MINUTE_MS);
      const base: EventInput = {
        calendarId: opts.calendarId,
        title: block.title,
        description: "",
        location: "",
        allDay: false,
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone: tz,
        recurrence: { freq: "WEEKLY", interval: 1, byWeekday: days },
        exdates: [],
        recurringEventId: null,
        originalStart: null,
        color: BLOCK_HUE[block.category] ?? null,
        reminders: [],
        guests: [],
        busy: true,
      };
      const label = `${group.label} ${block.title}`;
      const split = planAroundShabbat(base, opts.prefs, opts.weeks);
      if (split.series) plan.series.push({ key, event: split.series });
      for (const single of split.singles) plan.singles.push({ key: `${key}:${wallDateKey(new Date(single.start), tz)}`, event: single });
      if (split.through) plan.adjusted.push({ key, label, shortened: split.singles.length, skipped: split.skipped.length, through: split.through });
      if (!split.series && !split.singles.length) plan.dropped.push(label);
    }
  }
  return plan;
}

/** "Sun–Fri", "Mon, Wed" — the days a block repeats on, for the restore card. */
export function weekdaysLabel(days: number[]): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const run = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return run ? `${names[sorted[0]]}–${names[sorted[sorted.length - 1]]}` : sorted.map((d) => names[d]).join(", ");
}
