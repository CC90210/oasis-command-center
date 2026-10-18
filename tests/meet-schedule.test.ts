/**
 * A meeting made for later on its host's Schedule (lib/meet/schedule.ts addMeetingToSchedule), with the Schedule's
 * store stood in: the event is shaped like one from the Schedule's own editor (the default calendar, the owner's
 * default length unless the host chose one, a 10-minute reminder, busy) and carries the meeting's link; the
 * Schedule's own refusals (Shabbat, a bad zone) come back as reasons, never as a failed meeting.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-schedule.test.ts
 */
import assert from "node:assert/strict";
import { CalendarStoreError } from "../lib/calendar/store";
import type { CalendarPrefs, CalendarRecord, EventOp } from "../lib/calendar/types";
import type { MeetRoom } from "../lib/meet/rooms";
import { addMeetingToSchedule, removeMeetingFromSchedule, type ScheduleStore } from "../lib/meet/schedule";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const OWNER = { tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452", userId: "11111111-0000-4000-8000-000000000001" };
const room: MeetRoom = {
  id: "room-1", tenantId: OWNER.tenantId, code: "abcdefghjk", title: "Follow-up with Acme", hostUserId: OWNER.userId,
  status: "scheduled", recordAudio: true, startsAt: "2026-10-21T18:00:00.000Z", calendarEventId: null, leadId: null,
  createdAt: "2026-10-17T16:00:00.000Z", startedAt: null, endedAt: null, endedReason: null,
};
const calendar = (id: string, isDefault: boolean): CalendarRecord => ({ id, name: id, color: "blue" as CalendarRecord["color"], visible: true, isDefault, position: 0, createdAt: "", updatedAt: "" });

function fakeStore(opts: { calendars?: CalendarRecord[]; refuse?: CalendarStoreError } = {}) {
  const ops: Array<{ owner: unknown; ops: EventOp[] }> = [];
  const store: ScheduleStore = {
    listCalendars: (async () => opts.calendars ?? [calendar("work", false), calendar("main", true)]) as ScheduleStore["listCalendars"],
    getPrefs: (async () => ({ defaultDurationMin: 30 }) as CalendarPrefs) as ScheduleStore["getPrefs"],
    applyOps: (async (owner: unknown, list: EventOp[]) => {
      ops.push({ owner, ops: list });
      if (opts.refuse) throw opts.refuse;
      return [{ op: "create", id: "evt-9", tempId: undefined, event: {} }];
    }) as unknown as ScheduleStore["applyOps"],
    origin: () => "https://oasisai.work",
  };
  return { store, ops };
}

async function main() {
  console.log("meet schedule:");

  await check("the event: default calendar, the room's title, its link, the owner's default length, a 10-minute reminder", async () => {
    const { store, ops } = fakeStore();
    const out = await addMeetingToSchedule(OWNER, room, { timeZone: "America/Toronto" }, store);
    assert.deepEqual(out, { ok: true, eventId: "evt-9" });
    assert.deepEqual(ops[0].owner, OWNER);
    const op = ops[0].ops[0] as Extract<EventOp, { op: "create" }>;
    assert.equal(op.op, "create");
    assert.equal(op.event.calendarId, "main", "the default calendar, not the first one");
    assert.equal(op.event.title, "Follow-up with Acme");
    assert.equal(op.event.location, "https://oasisai.work/meet/abc-defg-hjk");
    assert.equal(op.event.description, "Oasis Meet: https://oasisai.work/meet/abc-defg-hjk");
    assert.equal(op.event.start, "2026-10-21T18:00:00.000Z");
    assert.equal(op.event.end, "2026-10-21T18:30:00.000Z", "the owner's default length");
    assert.equal(op.event.timeZone, "America/Toronto");
    assert.deepEqual(op.event.reminders, [10]);
    assert.equal(op.event.busy, true);
    assert.equal(op.event.allDay, false);
  });

  await check("the link is the one canonical link, whatever the app's address ends with", async () => {
    const { store, ops } = fakeStore();
    await addMeetingToSchedule(OWNER, room, { timeZone: "America/Toronto" }, { ...store, origin: () => "https://oasisai.work/" });
    const op = ops[0].ops[0] as Extract<EventOp, { op: "create" }>;
    assert.equal(op.event.location, "https://oasisai.work/meet/abc-defg-hjk", "never //meet");
  });

  await check("a length the host chose wins over the default", async () => {
    const { store, ops } = fakeStore();
    await addMeetingToSchedule(OWNER, room, { timeZone: "America/Toronto", minutes: 60 }, store);
    assert.equal((ops[0].ops[0] as Extract<EventOp, { op: "create" }>).event.end, "2026-10-21T19:00:00.000Z");
  });

  await check("the Schedule's refusals come back as reasons in plain words; a bad zone never reaches the store", async () => {
    const shabbat = fakeStore({ refuse: new CalendarStoreError("shabbat_protected", 409) });
    const out = await addMeetingToSchedule(OWNER, room, { timeZone: "America/Toronto" }, shabbat.store);
    assert.deepEqual(out, { ok: false, reason: "shabbat_protected" });
    const badZone = fakeStore();
    assert.deepEqual(await addMeetingToSchedule(OWNER, room, { timeZone: "Mars/Olympus" }, badZone.store), { ok: false, reason: "time_zone_invalid" });
    assert.equal(badZone.ops.length, 0);
    assert.deepEqual(await addMeetingToSchedule(OWNER, room, { timeZone: "America/Toronto" }, fakeStore({ calendars: [] }).store), { ok: false, reason: "no_calendar" });
    assert.deepEqual(await addMeetingToSchedule(OWNER, { ...room, startsAt: null }, { timeZone: "America/Toronto" }, fakeStore().store), { ok: false, reason: "no_time" });
  });

  await check("a storage fault that is not the Schedule's own refusal is not swallowed", async () => {
    const broken = fakeStore();
    broken.store.applyOps = (async () => {
      throw new TypeError("network down");
    }) as unknown as ScheduleStore["applyOps"];
    await assert.rejects(addMeetingToSchedule(OWNER, room, { timeZone: "America/Toronto" }, broken.store), /network down/);
  });

  await check("a deleted meeting comes off its creator's Schedule by its event id; a fault there is logged, never thrown", async () => {
    const { store, ops } = fakeStore();
    await removeMeetingFromSchedule(OWNER, "evt-9", store);
    assert.deepEqual(ops, [{ owner: OWNER, ops: [{ op: "delete", id: "evt-9" }] }]);
    const broken = fakeStore();
    broken.store.applyOps = (async () => {
      throw new TypeError("network down");
    }) as unknown as ScheduleStore["applyOps"];
    const logged: unknown[][] = [];
    const errors = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await removeMeetingFromSchedule(OWNER, "evt-9", broken.store);
    } finally {
      console.error = errors;
    }
    assert.equal(logged.length, 1, "the meeting is deleted either way, and the fault is in the log");
    assert.match(String(logged[0][1]), /network down/);
  });

  if (failures) {
    console.error(`meet schedule: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet schedule: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
