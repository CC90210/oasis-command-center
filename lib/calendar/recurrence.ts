/**
 * Recurrence expansion and the "this / following / all" edit planner.
 *
 * Timed series expand in the event's own zone (see seriesStarts), so the
 * browser, another device and the UTC server agree on every instant.
 */

import {
  addDays,
  daysInMonth,
  fromDateKey,
  isDateKey,
  ordinal,
  toDateKey,
  weekdayLong,
  weekdayShort,
  monthLong,
  MINUTE_MS,
} from "./dates";
import { dayNumber, fromDayNumber, instantOf, wallDateKey, wallParts, wallWeekday } from "./zone";
import type {
  EditScope,
  EventInput,
  EventOp,
  EventRecord,
  Occurrence,
  Recurrence,
} from "./types";

/** Hard ceiling so a malformed rule can never spin the renderer. */
const MAX_ITERATIONS = 5000;

export function eventStart(e: Pick<EventRecord, "allDay" | "start">): Date {
  return e.allDay ? fromDateKey(e.start) : new Date(e.start);
}

export function eventEnd(e: Pick<EventRecord, "allDay" | "end">): Date {
  return e.allDay ? fromDateKey(e.end) : new Date(e.end);
}

/** The key that identifies an instance inside its series. */
export function instanceKey(allDay: boolean, start: Date): string {
  return allDay ? toDateKey(start) : start.toISOString();
}

/** nth weekday of the month for a date: 1..5, and whether it is the last one. */
export function nthWeekdayOf(d: Date): { n: number; last: boolean } {
  return nthOf(d.getFullYear(), d.getMonth(), d.getDate());
}

function nthOf(y: number, m: number, d: number): { n: number; last: boolean } {
  return { n: Math.floor((d - 1) / 7) + 1, last: d + 7 > daysInMonth(y, m) };
}

function keyDay(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return dayNumber(y, m - 1, d);
}

/** Day of month of the nth (or last) `weekday` in a month, or null if there is none. */
function nthWeekdayInMonth(year: number, month: number, weekday: number, n: number, last: boolean): number | null {
  const dim = daysInMonth(year, month);
  if (last) {
    const lastWd = fromDayNumber(dayNumber(year, month, dim)).weekday;
    return dim - ((lastWd - weekday + 7) % 7);
  }
  const firstWd = fromDayNumber(dayNumber(year, month, 1)).weekday;
  const day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7;
  return day > dim ? null : day;
}

/**
 * Candidate start instants of a series, in order, from its first occurrence.
 * Honors interval, byWeekday, monthly mode, until and count. Exdates are
 * applied by the caller so `count` counts them (as RFC 5545 does).
 *
 * Timed series are expanded on wall dates in the event's OWN zone, so every
 * device and the UTC server derive the same instants (and the same exception
 * keys); 9am stays 9am in that zone across DST. All-day series are dates and
 * expand on the runtime's calendar, which yields the same date keys anywhere.
 */
export function* seriesStarts(master: Pick<EventRecord, "allDay" | "start" | "recurrence" | "timeZone">): Generator<Date> {
  const rule = master.recurrence;
  const first = eventStart(master);
  if (!rule) {
    yield first;
    return;
  }
  const tz = master.allDay ? null : master.timeZone;
  const w = tz
    ? wallParts(first, tz)
    : { y: first.getFullYear(), m: first.getMonth(), d: first.getDate(), h: 0, mi: 0, s: 0 };
  const at = (y: number, m: number, d: number): Date =>
    tz ? instantOf({ y, m, d, h: w.h, mi: w.mi, s: w.s }, tz) : new Date(y, m, d);
  const firstDay = dayNumber(w.y, w.m, w.d);
  const firstWd = fromDayNumber(firstDay).weekday;

  const interval = Math.max(1, Math.min(99, Math.floor(rule.interval || 1)));
  // `until` is a wall date in the event's zone, inclusive.
  const untilDay = rule.until && isDateKey(rule.until) ? keyDay(rule.until) : Infinity;
  const count = rule.count && rule.count > 0 ? rule.count : Infinity;
  let emitted = 0;
  let guard = 0;
  // True when the series is finished.
  const done = (day: number) => day > untilDay || emitted >= count;

  if (rule.freq === "DAILY") {
    for (let day = firstDay; guard++ < MAX_ITERATIONS; day += interval) {
      if (done(day)) return;
      const p = fromDayNumber(day);
      emitted++;
      yield at(p.y, p.m, p.d);
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const days = (rule.byWeekday?.length ? [...new Set(rule.byWeekday)] : [firstWd])
      .filter((d) => d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    // Weeks are anchored on the Sunday of the first occurrence's week.
    const weekZero = firstDay - firstWd;
    for (let wk = 0; guard++ < MAX_ITERATIONS; wk += interval) {
      for (const wd of days) {
        const day = weekZero + wk * 7 + wd;
        if (day < firstDay) continue;
        if (done(day)) return;
        const p = fromDayNumber(day);
        emitted++;
        yield at(p.y, p.m, p.d);
      }
    }
    return;
  }

  if (rule.freq === "MONTHLY") {
    // An explicit ordinal (set when a series is split) wins over the one the
    // first date implies: a "last Monday" series may start on a 4th Monday.
    const implied = nthOf(w.y, w.m, w.d);
    const n = rule.nth === -1 ? 5 : rule.nth ?? implied.n;
    const last = rule.nth === -1 || (rule.nth === undefined && implied.last);
    for (let k = 0; guard++ < MAX_ITERATIONS; k += interval) {
      const y = w.y + Math.floor((w.m + k) / 12);
      const m = (w.m + k) % 12;
      // By date, the 31st only recurs in months that have one, as Google does.
      const d = rule.monthlyMode === "nth"
        ? nthWeekdayInMonth(y, m, firstWd, n, last && n === 5)
        : w.d <= daysInMonth(y, m) ? w.d : null;
      if (d === null) continue;
      const day = dayNumber(y, m, d);
      if (day < firstDay) continue;
      if (done(day)) return;
      emitted++;
      yield at(y, m, d);
    }
    return;
  }

  // YEARLY: same month and day; Feb 29 only in leap years.
  for (let k = 0; guard++ < MAX_ITERATIONS; k += interval) {
    const y = w.y + k;
    if (w.d > daysInMonth(y, w.m)) continue;
    if (done(dayNumber(y, w.m, w.d))) return;
    emitted++;
    yield at(y, w.m, w.d);
  }
}

/**
 * Every instance that intersects [rangeStart, rangeEnd).
 * `events` is the full row set: masters, one-offs and overrides.
 */
export function expandOccurrences(events: EventRecord[], rangeStart: Date, rangeEnd: Date): Occurrence[] {
  const overrides = new Map<string, EventRecord>();
  for (const e of events) {
    if (e.recurringEventId && e.originalStart) overrides.set(`${e.recurringEventId}@${e.originalStart}`, e);
  }
  const out: Occurrence[] = [];
  const intersects = (s: Date, en: Date) => s < rangeEnd && en > rangeStart;

  for (const e of events) {
    if (e.recurringEventId) continue; // emitted through its master
    const start = eventStart(e);
    const end = eventEnd(e);
    const duration = Math.max(0, end.getTime() - start.getTime());

    if (!e.recurrence) {
      if (intersects(start, end.getTime() === start.getTime() ? new Date(start.getTime() + 1) : end))
        out.push({ key: e.id, event: e, master: null, start, end, allDay: e.allDay, originalStart: null });
      continue;
    }

    const exdates = new Set(e.exdates);
    for (const s of seriesStarts(e)) {
      if (s >= rangeEnd) break;
      const key = instanceKey(e.allDay, s);
      if (exdates.has(key)) continue;
      const override = overrides.get(`${e.id}@${key}`);
      if (override) continue; // placed below; it may have moved into or out of range
      const en = e.allDay ? addDays(s, Math.round(duration / 86_400_000)) : new Date(s.getTime() + duration);
      if (!intersects(s, en)) continue;
      out.push({ key: `${e.id}@${key}`, event: e, master: e, start: s, end: en, allDay: e.allDay, originalStart: key });
    }
  }

  const masters = new Map(events.filter((e) => e.recurrence).map((e) => [e.id, e]));
  for (const o of overrides.values()) {
    const master = masters.get(o.recurringEventId!);
    if (!master || master.exdates.includes(o.originalStart!)) continue;
    // An edit whose slot the series no longer has (it was shortened, or its
    // days changed) is not shown: it would be an event the rule excludes.
    if (!isInstanceOf(master, o.originalStart!)) continue;
    const s = eventStart(o);
    const en = eventEnd(o);
    if (!intersects(s, en)) continue;
    out.push({ key: `${master.id}@${o.originalStart}`, event: o, master, start: s, end: en, allDay: o.allDay, originalStart: o.originalStart });
  }

  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
}

// ── Human text ────────────────────────────────────────────────────────────

export function describeRecurrence(rule: Recurrence | null, start: Date): string {
  if (!rule) return "Does not repeat";
  const every = (unit: string) => (rule.interval > 1 ? `Every ${rule.interval} ${unit}s` : `${unit[0].toUpperCase()}${unit.slice(1)}ly`);
  let text: string;
  switch (rule.freq) {
    case "DAILY":
      text = rule.interval > 1 ? `Every ${rule.interval} days` : "Daily";
      break;
    case "WEEKLY": {
      const days = (rule.byWeekday?.length ? rule.byWeekday : [start.getDay()]).slice().sort();
      const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
      const on = weekdays ? "every weekday" : days.length === 7 ? "every day" : `on ${days.map((d) => (days.length > 2 ? weekdayShort(d) : weekdayLong(d))).join(", ")}`;
      text = `${every("week")} ${on}`;
      break;
    }
    case "MONTHLY": {
      if (rule.monthlyMode === "nth") {
        const implied = nthWeekdayOf(start);
        const n = rule.nth === -1 ? 5 : rule.nth ?? implied.n;
        const last = rule.nth === -1 || (rule.nth === undefined && implied.last);
        text = `${every("month")} on the ${last && n === 5 ? "last" : ordinal(n)} ${weekdayLong(start.getDay())}`;
      } else text = `${every("month")} on day ${start.getDate()}`;
      break;
    }
    default:
      text = rule.interval > 1 ? `Every ${rule.interval} years on ${monthLong(start.getMonth())} ${start.getDate()}` : `Annually on ${monthLong(start.getMonth())} ${start.getDate()}`;
  }
  if (rule.until) {
    const u = fromDateKey(rule.until);
    text += `, until ${monthLong(u.getMonth()).slice(0, 3)} ${u.getDate()}, ${u.getFullYear()}`;
  } else if (rule.count) text += `, ${rule.count} times`;
  return text;
}

// ── Edit planning ─────────────────────────────────────────────────────────

function inputOf(e: EventRecord): EventInput {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = e;
  return rest;
}

/** Weekday of an instant in the series' own calendar (its zone, or the date for all-day). */
function weekdayIn(e: Pick<EventRecord, "allDay" | "timeZone">, instant: Date): number {
  return e.allDay ? instant.getDay() : wallWeekday(instant, e.timeZone);
}

/** `YYYY-MM-DD` of the day before an instance, in the series' own calendar. */
function dayBeforeIn(e: Pick<EventRecord, "allDay" | "timeZone">, instant: Date): string {
  return keyOfDay(keyDay(dayKeyIn(e, instant)) - 1);
}

/** How many instances of a series start before `beforeMs` (exdates included, as count does). */
function startsBefore(master: EventRecord, beforeMs: number): number {
  let n = 0;
  for (const s of seriesStarts(master)) {
    if (s.getTime() >= beforeMs) break;
    n++;
  }
  return n;
}

const DAY_MS = 86_400_000;

/**
 * Plan the persisted ops for editing one occurrence.
 *
 * `next` is the full desired state of the edited instance (its start/end are
 * the instance's new times; `recurrence: null` means "does not repeat"). Ops
 * are ordered so a partial failure never loses data: creates run before the
 * truncation of the old series.
 */
export function planEdit(occ: Occurrence, next: EventInput, scope: EditScope, allRows: EventRecord[]): EventOp[] {
  const master = occ.master;
  // A one-off event.
  if (!master) return [{ op: "update", id: occ.event.id, patch: next }];

  const origKey = occ.originalStart!;
  if (scope === "this") {
    const single: EventInput = { ...next, recurrence: null, exdates: [], recurringEventId: master.id, originalStart: origKey };
    if (occ.event.id !== master.id) return [{ op: "update", id: occ.event.id, patch: single }];
    return [{ op: "create", event: single }];
  }

  const newStartDate = eventStart(next);
  // Instances are re-keyed when they move or change between timed and all-day.
  const reshaped = newStartDate.getTime() !== occ.start.getTime() || next.allDay !== master.allDay;
  // What the user changed on THIS occurrence, as deltas: whole days (in each
  // side's own calendar), wall-clock minutes, and duration. Series-wide edits
  // apply these deltas to the series' own values, so a rename of an instance
  // that was moved or lengthened on its own never moves or lengthens the rest.
  const dayShift = keyDay(dayKeyIn(next, newStartDate)) - keyDay(dayKeyIn(master, occ.start));
  const timed = !next.allDay && !master.allDay;
  const minuteShift = timed ? wallMinutes(newStartDate, next.timeZone) - wallMinutes(occ.start, master.timeZone) : 0;
  const durationShift = eventEnd(next).getTime() - newStartDate.getTime() - (occ.end.getTime() - occ.start.getTime());
  const seriesDuration = Math.max(60_000, eventEnd(master).getTime() - eventStart(master).getTime() + durationShift);
  /** Start/end for the instance whose unedited start is `base`, with the user's deltas applied. */
  const placeFrom = (base: Date) => {
    const total = (timed ? wallMinutes(base, master.timeZone) : 0) + minuteShift;
    const day = keyDay(dayKeyIn(master, base)) + dayShift + Math.floor(total / 1440);
    const minuteOfDay = ((total % 1440) + 1440) % 1440;
    return placeAt(next, day, newStartDate, seriesDuration, timed ? minuteOfDay : undefined);
  };
  // Moving an occurrence of an unchanged weekly rule moves its weekdays too.
  const follow = (r: Recurrence, from: Date, to: Date) => followMove(r, weekdayIn(master, from), weekdayIn(next, to));
  const overridesFrom = (fromMs: number) =>
    allRows
      .filter((r) => r.recurringEventId === master.id && r.originalStart && keyTime(r.originalStart, master.allDay) >= fromMs)
      .map((r) => ({ op: "delete" as const, id: r.id }));

  if (scope === "all") {
    if (!next.recurrence) {
      // "Does not repeat", for all: the series becomes this one event.
      return [
        { op: "update", id: master.id, patch: { ...next, recurrence: null, exdates: [], recurringEventId: null, originalStart: null } },
        ...overridesFrom(-Infinity),
      ];
    }
    const { start, end } = placeFrom(eventStart(master));
    const rule = sameRule(next.recurrence, master.recurrence) ? follow(next.recurrence, occ.start, newStartDate) : next.recurrence;
    // A changed rule (shorter, other days) can leave edits whose slot is gone:
    // delete those rows rather than keep data the calendar will never show.
    const probe: EventRecord = { ...master, allDay: next.allDay, timeZone: next.timeZone, start, end, recurrence: rule };
    const stale = reshaped
      ? []
      : allRows
          .filter((r) => r.recurringEventId === master.id && r.originalStart && !isInstanceOf(probe, r.originalStart))
          .map((r) => ({ op: "delete" as const, id: r.id }));
    return [
      {
        op: "update",
        id: master.id,
        patch: { ...next, start, end, recurrence: rule, exdates: reshaped ? [] : master.exdates, recurringEventId: null, originalStart: null },
      },
      // Re-keyed instances leave single-occurrence edits pointing at nothing;
      // they would render as duplicates. Google Calendar discards them too.
      ...(reshaped ? overridesFrom(-Infinity) : stale),
    ];
  }

  // "following": end the old series the day before this instance's ORIGINAL
  // slot and start a new one there. An instance that was moved on its own is
  // still split at its place in the series, never at where it was dragged to,
  // or the cutoff, the remaining count and the old slot would all be wrong.
  const origTime = keyTime(origKey, master.allDay);
  const origDate = new Date(origTime);
  if (eventStart(master).getTime() === origTime) return planEdit(occ, next, "all", allRows);
  const anchored = { ...next, ...placeFrom(origDate) };
  const oldRule = master.recurrence!;
  let newRule: Recurrence | null;
  if (!next.recurrence) newRule = null;
  else if (sameRule(next.recurrence, oldRule)) {
    // Same rule: the new series carries on where the old one stops, so a
    // count-limited series keeps only the instances it had left, and a
    // "last Monday" series stays last-Monday although it now starts on a 4th.
    const remaining = oldRule.count ? Math.max(1, oldRule.count - startsBefore(master, origTime)) : undefined;
    const nth = oldRule.freq === "MONTHLY" && oldRule.monthlyMode === "nth" ? { nth: seriesNth(master) } : {};
    newRule = follow({ ...oldRule, ...nth, count: remaining }, origDate, eventStart(anchored));
  } else newRule = { ...next.recurrence };
  return [
    { op: "create", event: { ...anchored, recurrence: newRule, exdates: [], recurringEventId: null, originalStart: null } },
    { op: "update", id: master.id, patch: { recurrence: { ...oldRule, count: undefined, until: dayBeforeIn(master, origDate) } } },
    // Overrides at or after the split belonged to the old tail; Google drops them.
    ...overridesFrom(origTime),
  ];
}

/** The ordinal a monthly-by-weekday series repeats on: 1..4, or -1 for "last". */
function seriesNth(master: Pick<EventRecord, "allDay" | "start" | "timeZone" | "recurrence">): number {
  if (master.recurrence?.nth) return master.recurrence.nth;
  const first = eventStart(master);
  const w = master.allDay ? { y: first.getFullYear(), m: first.getMonth(), d: first.getDate() } : wallParts(first, master.timeZone);
  const { n, last } = nthOf(w.y, w.m, w.d);
  return last && n === 5 ? -1 : n;
}

/** Minutes past midnight of an instant's wall-clock time in `tz`. */
function wallMinutes(instant: Date, tz: string): number {
  const w = wallParts(instant, tz);
  return w.h * 60 + w.mi;
}

/** `YYYY-MM-DD` of an instant in an event's own calendar. */
function dayKeyIn(e: Pick<EventRecord, "allDay" | "timeZone">, instant: Date): string {
  return e.allDay ? toDateKey(instant) : wallDateKey(instant, e.timeZone);
}

function keyOfDay(n: number): string {
  const p = fromDayNumber(n);
  return `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Start/end strings for an event placed on day `day`, at `timeOf`'s wall time in its zone. */
function placeAt(e: Pick<EventInput, "allDay" | "timeZone">, day: number, timeOf: Date, durationMs: number, minuteOfDay?: number): { start: string; end: string } {
  if (e.allDay) return { start: keyOfDay(day), end: keyOfDay(day + Math.max(1, Math.round(durationMs / DAY_MS))) };
  const p = fromDayNumber(day);
  const w = minuteOfDay === undefined ? wallParts(timeOf, e.timeZone) : { h: Math.floor(minuteOfDay / 60), mi: minuteOfDay % 60 };
  const s = instantOf({ y: p.y, m: p.m, d: p.d, h: w.h, mi: w.mi, s: 0 }, e.timeZone);
  return { start: s.toISOString(), end: new Date(s.getTime() + durationMs).toISOString() };
}

function keyTime(key: string, allDay: boolean): number {
  return allDay ? fromDateKey(key).getTime() : new Date(key).getTime();
}

export function sameRule(a: Recurrence | null, b: Recurrence | null): boolean {
  if (!a || !b) return a === b;
  const norm = (r: Recurrence) =>
    JSON.stringify([r.freq, r.interval, [...(r.byWeekday ?? [])].sort(), r.monthlyMode ?? "day", r.nth ?? null, r.until ?? null, r.count ?? null]);
  return norm(a) === norm(b);
}

/** Weekly rule with its weekdays moved by the same number of days as the event. */
function followMove(rule: Recurrence, fromWd: number, toWd: number): Recurrence {
  if (rule.freq !== "WEEKLY" || !rule.byWeekday?.length || fromWd === toWd) return rule;
  const shift = (toWd - fromWd + 7) % 7;
  return { ...rule, byWeekday: [...new Set(rule.byWeekday.map((d) => (d + shift) % 7))].sort() };
}

/** Ops for deleting an occurrence under a scope. */
export function planDelete(occ: Occurrence, scope: EditScope, allRows: EventRecord[]): EventOp[] {
  const master = occ.master;
  if (!master) return [{ op: "delete", id: occ.event.id }];
  if (scope === "all" || (scope === "following" && occ.originalStart !== null && eventStart(master).getTime() === keyTime(occ.originalStart, master.allDay))) {
    return [
      ...allRows.filter((r) => r.recurringEventId === master.id).map((r) => ({ op: "delete" as const, id: r.id })),
      { op: "delete", id: master.id },
    ];
  }
  const key = occ.originalStart!;
  if (scope === "this") {
    const ops: EventOp[] = [{ op: "update", id: master.id, patch: { exdates: [...new Set([...master.exdates, key])] } }];
    if (occ.event.id !== master.id) ops.push({ op: "delete", id: occ.event.id });
    return ops;
  }
  const ops: EventOp[] = [
    { op: "update", id: master.id, patch: { recurrence: { ...master.recurrence!, count: undefined, until: dayBeforeIn(master, new Date(keyTime(key, master.allDay))) } } },
  ];
  for (const row of allRows) {
    if (row.recurringEventId === master.id && row.originalStart && keyTime(row.originalStart, master.allDay) >= keyTime(key, master.allDay))
      ops.push({ op: "delete", id: row.id });
  }
  return ops;
}

/** Duration of an event in minutes (timed) or days*1440 (all-day). */
export function durationMinutes(e: Pick<EventRecord, "allDay" | "start" | "end">): number {
  return Math.round((eventEnd(e).getTime() - eventStart(e).getTime()) / MINUTE_MS);
}

export { inputOf };

/** True when `key` is an instance key the series' current rule still produces. */
export function isInstanceOf(master: EventRecord, key: string): boolean {
  const target = keyTime(key, master.allDay);
  for (const s of seriesStarts(master)) {
    const t = s.getTime();
    if (t === target) return true;
    if (t > target) return false;
  }
  return false;
}

/**
 * What removing a calendar must write, besides deleting its rows.
 *
 * A single occurrence can be moved into another calendar, which makes it an
 * override row living in a different calendar from its series. Deleting that
 * calendar deletes the override; without an exception on the surviving
 * series, the original instance would reappear. Conversely, overrides whose
 * series is being deleted go with it.
 */
export function planCalendarRemoval(rows: EventRecord[], calendarId: string): { deleteIds: string[]; exdates: Map<string, string[]> } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deleteIds = new Set<string>();
  const exdates = new Map<string, string[]>();
  for (const r of rows) {
    const master = r.recurringEventId ? byId.get(r.recurringEventId) : undefined;
    if (r.calendarId === calendarId || master?.calendarId === calendarId) deleteIds.add(r.id);
    if (r.calendarId === calendarId && master && master.calendarId !== calendarId && r.originalStart) {
      const list = exdates.get(master.id) ?? [...master.exdates];
      if (!list.includes(r.originalStart)) list.push(r.originalStart);
      exdates.set(master.id, list);
    }
  }
  return { deleteIds: [...deleteIds], exdates };
}
