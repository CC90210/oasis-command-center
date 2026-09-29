/**
 * The calendar store against a REAL local libSQL file with migration 186
 * applied, through the same Supabase-compatible shim production uses.
 * node --conditions=react-server --import tsx tests/calendar-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "calendar-store-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TZ = "America/Toronto";

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  const migration = readFileSync(join(root, "database/turso/186_calendar.turso.sql"), "utf8");
  await raw.executeMultiple(migration);
  await raw.executeMultiple(migration); // additive and re-runnable

  const store = await import("../lib/calendar/store");
  const { planDelete, expandOccurrences, seriesStarts } = await import("../lib/calendar/recurrence");
  const { DEFAULT_PREFS } = await import("../lib/calendar/types");
  type EventInput = import("../lib/calendar/types").EventInput;

  const adon = { tenantId: "tenant-a", userId: "user-a" };
  const other = { tenantId: "tenant-a", userId: "user-b" };

  // One default calendar, even when two first loads race.
  const [c1, c2] = await Promise.all([store.listCalendars(adon), store.listCalendars(adon)]);
  const cals = await store.listCalendars(adon);
  assert.equal(cals.length, 1, "one default calendar under a race");
  assert.equal(c1[0].id, c2[0].id);
  assert.equal(cals[0].isDefault, true, "0/1 booleans come back as booleans");
  const personal = cals[0].id;

  const at = (s: string) => new Date(s).toISOString();
  const input = (p: Partial<EventInput>): EventInput => ({
    calendarId: personal, title: "t", description: "", location: "", allDay: false,
    start: at("2026-10-05T09:00"), end: at("2026-10-05T10:00"), timeZone: "America/Toronto",
    recurrence: null, exdates: [], recurringEventId: null, originalStart: null, color: null,
    reminders: [10], guests: ["a@example.com"], busy: true, ...p,
  });

  // A series and 70 single-occurrence edits in ONE batch (the old 60-op cap
  // made such a series undeletable). Overrides reference the master's temp id.
  // Weekdays only: a daily 9am series reaches Saturday, and the lock (rightly) refuses it.
  const series = input({ title: "weekdays", recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [1, 2, 3, 4, 5], count: 80 } });
  const slots = [...seriesStarts({ ...series, id: "p", createdAt: "", updatedAt: "" })].slice(0, 70);
  const overrides = slots.map((day, i) => ({
    op: "create" as const,
    event: input({ title: `edit ${i}`, recurringEventId: "tmp-master", originalStart: day.toISOString(), start: day.toISOString(), end: new Date(day.getTime() + 3_600_000).toISOString() }),
  }));
  const created = await store.applyOps(adon, [{ op: "create", tempId: "tmp-master", event: series }, ...overrides], DEFAULT_PREFS);
  assert.equal(created.length, 71);
  const masterId = created[0].id;
  let { events } = await store.listEvents(adon);
  assert.equal(events.length, 71);
  assert.ok(events.filter((e) => e.recurringEventId).every((e) => e.recurringEventId === masterId), "temp id mapped to the real master id");
  const master = events.find((e) => e.id === masterId)!;
  assert.deepEqual(master.reminders, [10], "JSON columns come back parsed");
  assert.equal(master.recurrence?.count, 80);

  // Deleting the whole series: 71 ops, one request, nothing left.
  const occ = expandOccurrences(events, new Date(2026, 9, 5), new Date(2026, 9, 6))[0];
  const del = planDelete(occ, "all", events);
  assert.equal(del.length, 71);
  await store.applyOps(adon, del, DEFAULT_PREFS);
  assert.equal((await store.listEvents(adon)).events.length, 0);

  // The Shabbat lock refuses before anything is written, even mid-batch.
  await assert.rejects(
    store.applyOps(adon, [
      { op: "create", event: input({ title: "fine" }) },
      { op: "create", event: input({ title: "friday night", start: at("2026-10-02T20:00"), end: at("2026-10-02T21:00") }) },
    ], DEFAULT_PREFS),
    (e: unknown) => e instanceof store.CalendarStoreError && e.code === "shabbat_protected",
  );
  assert.equal((await store.listEvents(adon)).events.length, 0, "the valid op in the refused batch did not land");

  // Private to its owner: another user sees nothing and cannot edit it.
  const [mine] = await store.applyOps(adon, [{ op: "create", event: input({ title: "mine" }) }], DEFAULT_PREFS);
  assert.equal((await store.listEvents(other)).events.length, 0);
  await assert.rejects(
    store.applyOps(other, [{ op: "update", id: mine.id, patch: { title: "stolen" } }], DEFAULT_PREFS),
    (e: unknown) => e instanceof store.CalendarStoreError && e.code === "event_not_found",
  );
  await store.applyOps(other, [{ op: "delete", id: mine.id }], DEFAULT_PREFS);
  assert.equal((await store.listEvents(adon)).events.length, 1, "another user's delete touches nothing");

  // Removing a calendar that holds an occurrence moved out of a series
  // elsewhere: the series gains an exception, the moved row goes.
  const side = await store.createCalendar(adon, { name: "Side", color: "moss" });
  const [s2] = await store.applyOps(adon, [{ op: "create", event: input({ title: "weekly", recurrence: { freq: "WEEKLY", interval: 1 } }) }], DEFAULT_PREFS);
  const slot = at("2026-10-12T09:00");
  await store.applyOps(adon, [{ op: "create", event: input({ calendarId: side.id, title: "moved", recurringEventId: s2.id, originalStart: slot, start: at("2026-10-13T11:00"), end: at("2026-10-13T12:00") }) }], DEFAULT_PREFS);
  await store.deleteCalendar(adon, side.id);
  events = (await store.listEvents(adon)).events;
  assert.ok(!events.some((e) => e.title === "moved"));
  assert.deepEqual(events.find((e) => e.id === s2.id)!.exdates, [slot], "the original slot does not come back");
  await assert.rejects(store.deleteCalendar(adon, personal), (e: unknown) => e instanceof store.CalendarStoreError && e.code === "default_calendar_protected");

  // Preferences: protective defaults until saved, then round-trip.
  assert.equal((await store.getPrefs(adon)).havdalahMinutesAfterSunset, 72);
  await store.savePrefs(adon, { ...DEFAULT_PREFS, weekStartsOn: 1 });
  await store.savePrefs(adon, { ...DEFAULT_PREFS, weekStartsOn: 1, showWeekends: false });
  const prefs = await store.getPrefs(adon);
  assert.equal(prefs.weekStartsOn, 1);
  assert.equal(prefs.showWeekends, false);

  console.log("calendar-store: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
