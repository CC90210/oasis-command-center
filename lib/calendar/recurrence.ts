/**
 * Recurrence expansion and the "this / following / all" edit planner.
 *
 * Expansion is done in the viewer's local zone and preserves wall-clock time
 * across DST: a 9am weekly meeting stays at 9am after the clocks change.
 */

import {
  addDays,
  daysInMonth,
  fromDateKey,
  isDateKey,
  ordinal,
  startOfDay,
  toDateKey,
  weekdayLong,
  weekdayShort,
  monthLong,
  MINUTE_MS,
} from "./dates";
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
  const n = Math.floor((d.getDate() - 1) / 7) + 1;
  const last = d.getDate() + 7 > daysInMonth(d.getFullYear(), d.getMonth());
  return { n, last };
}

function nthWeekdayInMonth(year: number, month: number, weekday: number, n: number, last: boolean): Date | null {
  if (last) {
    const lastDay = new Date(year, month, daysInMonth(year, month));
    const back = (lastDay.getDay() - weekday + 7) % 7;
    return new Date(year, month, lastDay.getDate() - back);
  }
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  if (day > daysInMonth(year, month)) return null;
  return new Date(year, month, day);
}

/** Copy the wall-clock time of `time` onto the calendar date of `day`. */
function withTimeOf(day: Date, time: Date): Date {
  const x = new Date(day);
  x.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), 0);
  return x;
}

/**
 * Candidate start dates of a series, in order, from its first occurrence.
 * Honors interval, byWeekday, monthly mode, until and count. Exdates are
 * applied by the caller so `count` counts them (as RFC 5545 does).
 */
export function* seriesStarts(master: Pick<EventRecord, "allDay" | "start" | "recurrence">): Generator<Date> {
  const rule = master.recurrence;
  const first = eventStart(master);
  if (!rule) {
    yield first;
    return;
  }
  const interval = Math.max(1, Math.min(99, Math.floor(rule.interval || 1)));
  const until = rule.until && isDateKey(rule.until) ? addDays(fromDateKey(rule.until), 1) : null;
  const count = rule.count && rule.count > 0 ? rule.count : Infinity;
  let emitted = 0;
  let guard = 0;

  const accept = (d: Date) => {
    if (until && d >= until) return false;
    return true;
  };

  if (rule.freq === "DAILY") {
    for (let i = 0; guard++ < MAX_ITERATIONS; i += interval) {
      const d = withTimeOf(addDays(startOfDay(first), i), first);
      if (!accept(d) || emitted >= count) return;
      emitted++;
      yield d;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const days = (rule.byWeekday?.length ? [...new Set(rule.byWeekday)] : [first.getDay()])
      .filter((d) => d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    // Weeks are anchored on the Sunday of the first occurrence's week.
    const weekZero = addDays(startOfDay(first), -first.getDay());
    for (let w = 0; guard++ < MAX_ITERATIONS; w += interval) {
      for (const wd of days) {
        const d = withTimeOf(addDays(weekZero, w * 7 + wd), first);
        if (d < first) continue;
        if (!accept(d) || emitted >= count) return;
        emitted++;
        yield d;
      }
    }
    return;
  }

  if (rule.freq === "MONTHLY") {
    const { n, last } = nthWeekdayOf(first);
    const byNth = rule.monthlyMode === "nth";
    for (let m = 0; guard++ < MAX_ITERATIONS; m += interval) {
      const monthDate = new Date(first.getFullYear(), first.getMonth() + m, 1);
      let day: Date | null;
      if (byNth) {
        day = nthWeekdayInMonth(monthDate.getFullYear(), monthDate.getMonth(), first.getDay(), n, last && n === 5);
      } else {
        // The 31st only recurs in months that have one, as Google does.
        day = first.getDate() <= daysInMonth(monthDate.getFullYear(), monthDate.getMonth())
          ? new Date(monthDate.getFullYear(), monthDate.getMonth(), first.getDate())
          : null;
      }
      if (!day) continue;
      const d = withTimeOf(day, first);
      if (d < first) continue;
      if (!accept(d) || emitted >= count) return;
      emitted++;
      yield d;
    }
    return;
  }

  // YEARLY: same month and day; Feb 29 only in leap years.
  for (let y = 0; guard++ < MAX_ITERATIONS; y += interval) {
    const year = first.getFullYear() + y;
    if (first.getDate() > daysInMonth(year, first.getMonth())) continue;
    const d = withTimeOf(new Date(year, first.getMonth(), first.getDate()), first);
    if (!accept(d) || emitted >= count) return;
    emitted++;
    yield d;
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
        const { n, last } = nthWeekdayOf(start);
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

/** Shift a stored start/end string by `ms` (timed) or whole days (all-day). */
function shiftValue(value: string, allDay: boolean, ms: number): string {
  if (allDay) return toDateKey(addDays(fromDateKey(value), Math.round(ms / 86_400_000)));
  return new Date(new Date(value).getTime() + ms).toISOString();
}

/**
 * Plan the persisted ops for editing one occurrence.
 *
 * `next` is the full desired state of the edited instance (its start/end are
 * the instance's new times). Ops are ordered so a partial failure never loses
 * data: creates run before the truncation of the old series.
 */
export function planEdit(occ: Occurrence, next: EventInput, scope: EditScope, allRows: EventRecord[]): EventOp[] {
  const master = occ.master;
  // One-off event, or an override edited as "this".
  if (!master) return [{ op: "update", id: occ.event.id, patch: next }];

  const origKey = occ.originalStart!;
  if (scope === "this") {
    const single: EventInput = { ...next, recurrence: null, exdates: [], recurringEventId: master.id, originalStart: origKey };
    if (occ.event.id !== master.id) return [{ op: "update", id: occ.event.id, patch: single }];
    return [{ op: "create", event: single }];
  }

  const oldStart = occ.start.getTime();
  const newStart = eventStart(next).getTime();
  const delta = newStart - oldStart;
  const durationMs = eventEnd(next).getTime() - newStart;

  if (scope === "all") {
    const masterStartMs = eventStart(master).getTime();
    const start = shiftValue(master.start, next.allDay, delta);
    const end = next.allDay
      ? toDateKey(addDays(fromDateKey(start), Math.max(1, Math.round(durationMs / 86_400_000))))
      : new Date(masterStartMs + delta + durationMs).toISOString();
    const recurrence = next.recurrence ?? master.recurrence;
    // Moving an occurrence of an unchanged weekly rule moves its weekdays too.
    const shiftedRule =
      recurrence && sameRule(recurrence, master.recurrence) ? followMove(recurrence, occ.start, eventStart(next)) : recurrence;
    return [{
      op: "update",
      id: master.id,
      patch: { ...next, start, end, recurrence: shiftedRule, exdates: delta === 0 ? master.exdates : [], recurringEventId: null, originalStart: null },
    }];
  }

  // "following": end the old series the day before, start a new one here.
  const isFirst = eventStart(master).getTime() === oldStart;
  if (isFirst) return planEdit(occ, next, "all", allRows);
  const dayBefore = toDateKey(addDays(startOfDay(occ.start), -1));
  const oldRule = master.recurrence!;
  const newRule: Recurrence =
    !next.recurrence || sameRule(next.recurrence, oldRule)
      ? followMove({ ...oldRule, count: undefined }, occ.start, eventStart(next))
      : { ...next.recurrence };
  const ops: EventOp[] = [
    { op: "create", event: { ...next, recurrence: newRule, exdates: [], recurringEventId: null, originalStart: null } },
    { op: "update", id: master.id, patch: { recurrence: { ...oldRule, count: undefined, until: dayBefore } } },
  ];
  // Overrides at or after the split belonged to the old tail; Google drops them.
  for (const row of allRows) {
    if (row.recurringEventId === master.id && row.originalStart && keyTime(row.originalStart, master.allDay) >= startOfDay(occ.start).getTime())
      ops.push({ op: "delete", id: row.id });
  }
  return ops;
}

function keyTime(key: string, allDay: boolean): number {
  return allDay ? fromDateKey(key).getTime() : new Date(key).getTime();
}

export function sameRule(a: Recurrence | null, b: Recurrence | null): boolean {
  if (!a || !b) return a === b;
  const norm = (r: Recurrence) =>
    JSON.stringify([r.freq, r.interval, [...(r.byWeekday ?? [])].sort(), r.monthlyMode ?? "day", r.until ?? null, r.count ?? null]);
  return norm(a) === norm(b);
}

/** Weekly rule with its weekdays moved by the same number of days as the event. */
function followMove(rule: Recurrence, from: Date, to: Date): Recurrence {
  if (rule.freq !== "WEEKLY" || !rule.byWeekday?.length || from.getDay() === to.getDay()) return rule;
  return { ...rule, byWeekday: shiftWeekdays(rule.byWeekday, from, to) };
}

function shiftWeekdays(days: number[], from: Date, to: Date): number[] {
  const shift = (to.getDay() - from.getDay() + 7) % 7;
  return [...new Set(days.map((d) => (d + shift) % 7))].sort();
}

/** Ops for deleting an occurrence under a scope. */
export function planDelete(occ: Occurrence, scope: EditScope, allRows: EventRecord[]): EventOp[] {
  const master = occ.master;
  if (!master) return [{ op: "delete", id: occ.event.id }];
  if (scope === "all" || (scope === "following" && eventStart(master).getTime() === occ.start.getTime() && occ.event.id === master.id)) {
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
  const dayBefore = toDateKey(addDays(startOfDay(new Date(keyTime(key, master.allDay))), -1));
  const ops: EventOp[] = [{ op: "update", id: master.id, patch: { recurrence: { ...master.recurrence!, count: undefined, until: dayBefore } } }];
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
