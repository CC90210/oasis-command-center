/**
 * Calendar engine: recurrence, edit planning, layout, sun + Shabbat, validation.
 * node --conditions=react-server --import tsx tests/calendar-engine.test.ts
 */
import assert from "node:assert/strict";
import { addDays, fromDateKey, toDateKey } from "../lib/calendar/dates";
import { layoutDay, layoutSpans } from "../lib/calendar/layout";
import { describeRecurrence, expandOccurrences, planDelete, planEdit, seriesStarts } from "../lib/calendar/recurrence";
import { shabbatForWeekOf, sunTimes } from "../lib/calendar/sun";
import { DEFAULT_PREFS, type EventRecord } from "../lib/calendar/types";
import { pickLegacyWeek, planLegacyImport } from "../lib/calendar/legacy";
import { createPlaceholderSchedule } from "../lib/schedule/model";
import { inputForOccurrence } from "../components/calendar/ui";
import { shabbatConflict, validateEventInput, validateOps, validatePrefs } from "../lib/calendar/validate";

// A DST zone, so wall-clock preservation is exercised on any machine. Node
// re-reads TZ at runtime; nothing above computes a date at import time.
process.env.TZ = "America/Toronto";
assert.equal(new Date("2026-07-01T12:00:00Z").getTimezoneOffset(), 240);

let seq = 0;
function ev(p: Partial<EventRecord>): EventRecord {
  return {
    id: p.id ?? `e${++seq}`,
    calendarId: "cal",
    title: "t",
    description: "",
    location: "",
    allDay: false,
    start: "2026-09-28T13:00:00.000Z",
    end: "2026-09-28T14:00:00.000Z",
    timeZone: "America/Toronto",
    recurrence: null,
    exdates: [],
    recurringEventId: null,
    originalStart: null,
    color: null,
    reminders: [],
    guests: [],
    busy: true,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}
const local = (s: string) => new Date(s); // no Z: parsed as local time
const take = <T>(g: Generator<T>, n: number) => {
  const out: T[] = [];
  for (const x of g) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
};

// ── Recurrence ────────────────────────────────────────────────────────────

// Weekly 9am survives the Nov 1 2026 DST change as 9am wall clock.
{
  const m = ev({ start: local("2026-10-26T09:00").toISOString(), end: local("2026-10-26T10:00").toISOString(), recurrence: { freq: "WEEKLY", interval: 1 } });
  const s = take(seriesStarts(m), 3);
  assert.deepEqual(s.map((d) => d.getHours()), [9, 9, 9]);
  assert.deepEqual(s.map(toDateKey), ["2026-10-26", "2026-11-02", "2026-11-09"]);
}

// Weekly on Mon/Wed/Fri, every 2 weeks, count 5 (count includes the first).
{
  const m = ev({ start: local("2026-09-28T08:00").toISOString(), end: local("2026-09-28T08:30").toISOString(), recurrence: { freq: "WEEKLY", interval: 2, byWeekday: [1, 3, 5], count: 5 } });
  assert.deepEqual([...seriesStarts(m)].map(toDateKey), ["2026-09-28", "2026-09-30", "2026-10-02", "2026-10-12", "2026-10-14"]);
}

// Monthly by day skips months without a 31st; nth mode keeps "last Friday".
{
  const m = ev({ start: local("2026-01-31T10:00").toISOString(), end: local("2026-01-31T11:00").toISOString(), recurrence: { freq: "MONTHLY", interval: 1 } });
  assert.deepEqual(take(seriesStarts(m), 3).map(toDateKey), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  const lastFri = ev({ start: local("2026-01-30T10:00").toISOString(), end: local("2026-01-30T11:00").toISOString(), recurrence: { freq: "MONTHLY", interval: 1, monthlyMode: "nth" } });
  assert.deepEqual(take(seriesStarts(lastFri), 3).map(toDateKey), ["2026-01-30", "2026-02-27", "2026-03-27"]);
  assert.equal(describeRecurrence(lastFri.recurrence, local("2026-01-30T10:00")), "Monthly on the last Friday");
}

// Yearly Feb 29 only in leap years; until is inclusive.
{
  const m = ev({ allDay: true, start: "2028-02-29", end: "2028-03-01", recurrence: { freq: "YEARLY", interval: 1 } });
  assert.deepEqual(take(seriesStarts(m), 2).map(toDateKey), ["2028-02-29", "2032-02-29"]);
  const d = ev({ allDay: true, start: "2026-09-28", end: "2026-09-29", recurrence: { freq: "DAILY", interval: 1, until: "2026-09-30" } });
  assert.deepEqual([...seriesStarts(d)].map(toDateKey), ["2026-09-28", "2026-09-29", "2026-09-30"]);
}

// Expansion honours exdates and places a moved override where it moved to.
{
  const m = ev({ id: "m", start: local("2026-09-28T09:00").toISOString(), end: local("2026-09-28T10:00").toISOString(), recurrence: { freq: "DAILY", interval: 1, count: 4 } });
  const key2 = local("2026-09-29T09:00").toISOString();
  const key3 = local("2026-09-30T09:00").toISOString();
  m.exdates = [key2];
  const moved = ev({ id: "o", recurringEventId: "m", originalStart: key3, start: local("2026-10-05T15:00").toISOString(), end: local("2026-10-05T16:00").toISOString(), title: "moved" });
  const occ = expandOccurrences([m, moved], local("2026-09-28T00:00"), local("2026-10-10T00:00"));
  assert.deepEqual(occ.map((o) => `${toDateKey(o.start)}:${o.event.title}`), ["2026-09-28:t", "2026-10-01:t", "2026-10-05:moved"]);
  assert.equal(occ[2].key, `m@${key3}`);
}

// ── Edit planning ─────────────────────────────────────────────────────────

{
  const m = ev({ id: "m", start: local("2026-09-28T09:00").toISOString(), end: local("2026-09-28T10:00").toISOString(), recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [1] } });
  const occs = expandOccurrences([m], local("2026-10-05T00:00"), local("2026-10-06T00:00"));
  const occ = occs[0];
  const { id: _i, createdAt: _c, updatedAt: _u, ...base } = m;
  const next = { ...base, start: local("2026-10-06T11:00").toISOString(), end: local("2026-10-06T12:00").toISOString() };

  const one = planEdit(occ, next, "this", [m]);
  assert.equal(one.length, 1);
  assert.equal(one[0].op, "create");
  assert.ok(one[0].op === "create" && one[0].event.recurringEventId === "m" && one[0].event.originalStart === occ.originalStart && one[0].event.recurrence === null);

  // Following: the new series is created BEFORE the old one is ended.
  const override = ev({ id: "o", recurringEventId: "m", originalStart: local("2026-10-12T09:00").toISOString() });
  const fol = planEdit(occ, next, "following", [m, override]);
  assert.deepEqual(fol.map((o) => o.op), ["create", "update", "delete"]);
  assert.ok(fol[1].op === "update" && fol[1].patch.recurrence?.until === "2026-10-04");
  assert.ok(fol[0].op === "create" && fol[0].event.recurrence?.byWeekday?.[0] === 2, "moved Mon->Tue shifts the weekday");

  // All: the master shifts by the same delta, Monday rule becomes Tuesday.
  const all = planEdit(occ, next, "all", [m]);
  assert.ok(all[0].op === "update");
  // A time change to the whole series drops its single-occurrence edits;
  // a title-only change to all keeps them.
  assert.deepEqual(planEdit(occ, next, "all", [m, override]).map((o) => o.op), ["update", "delete"]);
  const titleOnly = { ...base, title: "renamed", start: occ.start.toISOString(), end: occ.end.toISOString() };
  assert.deepEqual(planEdit(occ, titleOnly, "all", [m, override]).map((o) => o.op), ["update"]);
  assert.equal(new Date(all[0].patch.start!).getTime(), local("2026-09-29T11:00").getTime());
  assert.deepEqual(all[0].patch.recurrence?.byWeekday, [2]);

  const delThis = planDelete(occ, "this", [m]);
  assert.ok(delThis[0].op === "update" && delThis[0].patch.exdates?.includes(occ.originalStart!));
  const delAll = planDelete(occ, "all", [m, override]);
  assert.deepEqual(delAll.map((o) => o.op), ["delete", "delete"]);
}

// ── Codex review 2026-09-29: one regression per finding ───────────────────

{
  const weekly = ev({ id: "w", start: local("2026-10-05T09:00").toISOString(), end: local("2026-10-05T10:00").toISOString(), recurrence: { freq: "WEEKLY", interval: 1, count: 3 } });
  const occs = expandOccurrences([weekly], local("2026-10-01T00:00"), local("2026-11-01T00:00"));
  assert.equal(occs.length, 3);
  const second = occs[1];
  const { id: _i, createdAt: _c, updatedAt: _u, ...wbase } = weekly;

  // [P2] "this and following" on a count-limited series keeps the remaining count.
  const renamed = { ...wbase, title: "renamed", start: second.start.toISOString(), end: second.end.toISOString() };
  const split = planEdit(second, renamed, "following", [weekly]);
  assert.ok(split[0].op === "create" && split[0].event.recurrence?.count === 2, "2 of 3 remain, not an endless tail");

  // [P2] "Does not repeat" is honoured for all and for following.
  const once = { ...renamed, recurrence: null };
  const allOnce = planEdit(second, once, "all", [weekly]);
  assert.ok(allOnce[0].op === "update" && allOnce[0].patch.recurrence === null);
  const folOnce = planEdit(second, once, "following", [weekly]);
  assert.ok(folOnce[0].op === "create" && folOnce[0].event.recurrence === null);

  // [P2] A timed series turned all-day for "all" produces real date keys that validate.
  const allDayNext = { ...wbase, allDay: true, start: toDateKey(second.start), end: toDateKey(addDays(second.start, 1)) };
  const toAllDay = planEdit(second, allDayNext, "all", [weekly]);
  assert.ok(toAllDay[0].op === "update");
  assert.equal(toAllDay[0].patch.start, "2026-10-05", "the series' first day, not NaN-NaN-NaN");
  assert.ok(validateEventInput({ ...wbase, ...toAllDay[0].patch }).ok);

  // [P2] An individually edited occurrence can be reopened and saved again.
  const override = ev({ id: "ov", recurringEventId: "w", originalStart: second.originalStart, start: second.start.toISOString(), end: second.end.toISOString(), title: "moved" });
  const reopened = expandOccurrences([weekly, override], local("2026-10-01T00:00"), local("2026-11-01T00:00")).find((o) => o.event.id === "ov")!;
  const draft = inputForOccurrence(reopened);
  assert.deepEqual(draft.recurrence, weekly.recurrence, "the editor still shows the series' rule");
  assert.ok(validateEventInput(draft).ok, "and the draft validates");
  const again = planEdit(reopened, { ...draft, title: "moved again" }, "this", [weekly, override]);
  assert.ok(again[0].op === "update" && again[0].id === "ov" && again[0].patch.recurringEventId === "w" && again[0].patch.recurrence === null);

  // [P1] An unknown zone is refused rather than silently expanded in the server's zone.
  assert.equal((validateEventInput({ ...wbase, timeZone: "Mars/Olympus" }) as { error: string }).error, "time_zone_invalid");
}

// ── Layout ────────────────────────────────────────────────────────────────

{
  const day = local("2026-09-28T00:00");
  const a = ev({ start: local("2026-09-28T09:00").toISOString(), end: local("2026-09-28T11:00").toISOString() });
  const b = ev({ start: local("2026-09-28T10:00").toISOString(), end: local("2026-09-28T10:30").toISOString() });
  const c = ev({ start: local("2026-09-28T10:30").toISOString(), end: local("2026-09-28T12:00").toISOString() });
  const d = ev({ start: local("2026-09-28T14:00").toISOString(), end: local("2026-09-28T15:00").toISOString() });
  const occs = expandOccurrences([a, b, c, d], day, addDays(day, 1));
  const laid = layoutDay(day, occs);
  const by = (e: EventRecord) => laid.find((p) => p.occ.event.id === e.id)!;
  assert.equal(by(a).width, 0.5);
  assert.equal(by(b).left, 0.5);
  assert.equal(by(c).left, 0.5, "c reuses b's column once b ends");
  assert.equal(by(d).width, 1, "a lone event takes the full column");
  assert.equal(by(a).top, 540);

  const multi = ev({ allDay: true, start: "2026-09-27", end: "2026-09-30" });
  const single = ev({ allDay: true, start: "2026-09-28", end: "2026-09-29" });
  const week = Array.from({ length: 7 }, (_, i) => addDays(local("2026-09-27T00:00"), i));
  const spans = layoutSpans(week, expandOccurrences([multi, single], week[0], addDays(week[6], 1)), false);
  assert.equal(spans.find((s) => s.occ.event.id === multi.id)!.span, 3);
  assert.equal(spans.find((s) => s.occ.event.id === single.id)!.row, 1);
}

// ── Sun and Shabbat ───────────────────────────────────────────────────────

{
  const mtl = DEFAULT_PREFS.location;
  const within = (d: Date | null, hh: number, mm: number, tol = 3) => {
    assert.ok(d);
    const diff = Math.abs(d.getHours() * 60 + d.getMinutes() - (hh * 60 + mm));
    assert.ok(diff <= tol, `expected ~${hh}:${mm}, got ${d.getHours()}:${d.getMinutes()}`);
  };
  // Published Montréal sunsets: 8:46pm EDT at the June solstice, 4:13pm EST in December.
  within(sunTimes(fromDateKey("2026-06-21"), mtl.lat, mtl.lon).sunset, 20, 46);
  within(sunTimes(fromDateKey("2026-12-21"), mtl.lat, mtl.lon).sunset, 16, 13);
  // Polar night: no sunset, reported as null rather than invented.
  assert.equal(sunTimes(fromDateKey("2026-12-21"), 78.2, 15.6).sunset, null);

  const w = shabbatForWeekOf(local("2026-09-29T12:00"), DEFAULT_PREFS);
  assert.equal(toDateKey(w.start), "2026-10-02");
  assert.equal(w.start.getDay(), 5);
  assert.equal(w.end.getDay(), 6);
  assert.ok(w.computed);
  // From a Saturday, it is the Shabbat already in progress.
  assert.equal(toDateKey(shabbatForWeekOf(local("2026-10-03T10:00"), DEFAULT_PREFS).start), "2026-10-02");
  // Polar fallback protects a wide window instead of guessing.
  const polar = shabbatForWeekOf(local("2026-12-21T12:00"), { ...DEFAULT_PREFS, location: { label: "x", lat: 78.2, lon: 15.6 } });
  assert.equal(polar.computed, false);
}

// ── Validation + Shabbat lock ─────────────────────────────────────────────

{
  const { id: _i, createdAt: _c, updatedAt: _u, ...good } = ev({});
  assert.ok(validateEventInput(good).ok);
  assert.equal((validateEventInput({ ...good, end: good.start }) as { error: string }).error, "end_before_start");
  assert.equal((validateEventInput({ ...good, calendarId: "../x" }) as { error: string }).error, "calendar_id_invalid");
  assert.equal((validateEventInput({ ...good, guests: ["not an email"] }) as { error: string }).error, "guests_invalid");
  assert.equal((validateEventInput({ ...good, recurringEventId: "m" }) as { error: string }).error, "override_pair_invalid");
  assert.equal((validateEventInput({ ...good, recurrence: { freq: "WEEKLY", interval: 1, until: "2026-10-01", count: 3 } }) as { error: string }).error, "recurrence_until_and_count");
  const cleaned = validateEventInput({ ...good, title: "  hi\u0007 " });
  assert.ok(cleaned.ok && cleaned.value.title === "hi");
  assert.equal((validateOps([]) as { error: string }).error, "ops_empty");
  assert.equal((validatePrefs({ ...DEFAULT_PREFS, havdalahMinutesAfterSunset: 500 }) as { error: string }).error, "havdalahMinutesAfterSunset_invalid");

  const at = (s: string, e: string) => ({ ...good, start: local(s).toISOString(), end: local(e).toISOString() });
  assert.ok(shabbatConflict(at("2026-10-02T20:00", "2026-10-02T21:00"), DEFAULT_PREFS), "Friday night is protected");
  assert.ok(shabbatConflict(at("2026-10-03T12:00", "2026-10-03T13:00"), DEFAULT_PREFS), "Saturday noon is protected");
  assert.equal(shabbatConflict(at("2026-10-02T09:00", "2026-10-02T10:00"), DEFAULT_PREFS), null, "Friday morning is free");
  assert.equal(shabbatConflict(at("2026-10-04T09:00", "2026-10-04T10:00"), DEFAULT_PREFS), null, "Sunday is free");
  assert.equal(shabbatConflict(at("2026-10-03T12:00", "2026-10-03T13:00"), { ...DEFAULT_PREFS, shabbatProtection: false }), null);
  // A series is checked past its first occurrence: Thursday start, weekly on Fri evenings too.
  const series = { ...at("2026-10-01T19:00", "2026-10-01T20:00"), recurrence: { freq: "WEEKLY" as const, interval: 1, byWeekday: [4, 5] } };
  assert.ok(shabbatConflict(series, DEFAULT_PREFS), "a weekly Friday-evening occurrence is caught");
  const allDaySat = { ...good, allDay: true, start: "2026-10-03", end: "2026-10-04" };
  assert.ok(shabbatConflict(allDaySat, DEFAULT_PREFS));
  const allDayFri = { ...good, allDay: true, start: "2026-10-02", end: "2026-10-03" };
  assert.equal(shabbatConflict(allDayFri, DEFAULT_PREFS), null, "an all-day Friday marker is allowed");
}

// ── Legacy import (the old browser-only weekly template) ──────────────────

{
  const doc = createPlaceholderSchedule(local("2026-12-16T12:00")); // a winter week
  const newer = { ...doc, updatedAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(pickLegacyWeek(["not json", JSON.stringify(doc), JSON.stringify(newer), null])?.updatedAt, newer.updatedAt);
  const plan = planLegacyImport(doc, "cal", "America/Toronto", DEFAULT_PREFS);
  assert.ok(!plan.events.some((e) => e.title.startsWith("Shabbat")), "Shabbat blocks are computed now, never imported");
  assert.ok(!plan.events.some((e) => e.title === "Work"), "a Work container shown through its children is skipped");
  assert.ok(plan.events.every((e) => e.recurrence?.freq === "WEEKLY" && e.recurrence.byWeekday?.length === 1));
  const run = plan.events.find((e) => e.title === "Run" && new Date(e.start).getDay() === 1);
  assert.ok(run && new Date(run.start).getHours() === 7 && new Date(run.start).getMinutes() === 30);
  // Mid-December Montréal candle lighting is ~3:55pm: the Friday R&D block
  // (3:30-5pm) collides and must be named, not imported.
  assert.ok(plan.skippedForShabbat.includes("Friday Agent training / R&D"), plan.skippedForShabbat.join(", "));
  for (const e of plan.events) assert.equal(shabbatConflict(e, DEFAULT_PREFS), null);
}

console.log("calendar-engine: all checks passed");
