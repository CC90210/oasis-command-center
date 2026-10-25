/**
 * A meeting made for later, put on the Schedule by the REAL Schedule store (lib/calendar/store.ts applyOps,
 * listCalendars, getPrefs, validation and the Shabbat lock) on a throwaway libSQL file with migration 186: the
 * stand-in store in tests/meet-schedule.test.ts pins the event's shape; this proves the event really lands, reads
 * back the same, and that the Schedule's own rules refuse what they should.
 *
 * The data layer reads its target from the environment when it loads, so the environment is set before any app
 * module is imported (the same arrangement as tests/_delivery-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/meet-schedule-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "meet-schedule-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

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

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
const CC = "11111111-0000-4000-8000-000000000001";

async function main() {
  console.log("meet schedule (real store):");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(readFileSync(join(__dirname, "..", "database", "turso", "186_calendar.turso.sql"), "utf8"));
  const { addMeetingToSchedule, removeMeetingFromSchedule } = await import("../lib/meet/schedule");
  const { listEvents } = await import("../lib/calendar/store");
  type Room = Parameters<typeof addMeetingToSchedule>[1];
  const room = (tenantId: string, startsAt: string, title = "Follow-up with Acme"): Room => ({
    id: `room-${startsAt}`, tenantId, code: "abcdefghjk", title, hostUserId: CC, status: "scheduled", recordAudio: true,
    startsAt, calendarEventId: null, leadId: null, createdAt: "2026-10-17T16:00:00.000Z", startedAt: null, endedAt: null, endedReason: null,
  });
  const owner = { tenantId: OASIS, userId: CC };

  await check("a weekday meeting lands on the host's Schedule and reads back with its link, length and reminder", async () => {
    const out = await addMeetingToSchedule(owner, room(OASIS, "2026-10-21T18:00:00.000Z"), { timeZone: "America/Toronto", minutes: 45 });
    assert.equal(out.ok, true, JSON.stringify(out));
    const { events } = await listEvents(owner);
    const event = events.find((e) => out.ok && e.id === out.eventId);
    assert.ok(event, "the event is in the host's own calendar");
    assert.equal(event!.title, "Follow-up with Acme");
    assert.match(event!.location, /\/meet\/abc-defg-hjk$/);
    assert.equal(event!.description, `Oasis Meet: ${event!.location}`);
    assert.equal(Date.parse(event!.start), Date.parse("2026-10-21T18:00:00.000Z"));
    assert.equal(Date.parse(event!.end), Date.parse("2026-10-21T18:45:00.000Z"));
    assert.equal(event!.timeZone, "America/Toronto");
    assert.deepEqual(event!.reminders, [10]);
    assert.equal(event!.busy, true);
    assert.equal((await listEvents({ tenantId: OASIS, userId: "someone-else" })).events.length, 0, "nobody else's Schedule shows it");
  });

  await check("Saturday afternoon is refused by OASIS's Shabbat lock, and nothing is written", async () => {
    // Since 2026-10-25 no workspace starts with the lock; this host opts in, as Settings would.
    const { savePrefs } = await import("../lib/calendar/store");
    const { DEFAULT_PREFS } = await import("../lib/calendar/types");
    await savePrefs(owner, DEFAULT_PREFS);
    const before = (await listEvents(owner)).events.length;
    const out = await addMeetingToSchedule(owner, room(OASIS, "2026-10-24T20:00:00.000Z"), { timeZone: "America/Toronto" });
    assert.deepEqual(out, { ok: false, reason: "shabbat_protected" });
    assert.equal((await listEvents(owner)).events.length, before);
  });

  await check("a workspace without the lock keeps Saturday; the owner's default length applies when none was chosen", async () => {
    const other = { tenantId: OTHER, userId: CC };
    const out = await addMeetingToSchedule(other, room(OTHER, "2026-10-24T20:00:00.000Z"), { timeZone: "America/Toronto" });
    assert.equal(out.ok, true, JSON.stringify(out));
    const event = (await listEvents(other)).events.find((e) => out.ok && e.id === out.eventId)!;
    assert.equal(Date.parse(event.end) - Date.parse(event.start), 60 * 60_000, "this workspace's default length (60 minutes)");
  });

  await check("a time zone the Schedule cannot read is refused before anything is written", async () => {
    const before = (await listEvents(owner)).events.length;
    assert.deepEqual(await addMeetingToSchedule(owner, room(OASIS, "2026-10-22T18:00:00.000Z"), { timeZone: "Not/AZone" }), { ok: false, reason: "time_zone_invalid" });
    assert.equal((await listEvents(owner)).events.length, before);
  });

  await check("a deleted meeting comes off the host's Schedule; nobody else's delete reaches it; one already gone is a quiet no-op", async () => {
    const out = await addMeetingToSchedule(owner, room(OASIS, "2026-10-22T15:00:00.000Z"), { timeZone: "America/Toronto" });
    assert.equal(out.ok, true, JSON.stringify(out));
    if (!out.ok) return;
    const onSchedule = async () => (await listEvents(owner)).events.some((e) => e.id === out.eventId);
    await removeMeetingFromSchedule({ tenantId: OASIS, userId: "someone-else" }, out.eventId);
    assert.equal(await onSchedule(), true, "the store deletes only the owner's own events");
    await removeMeetingFromSchedule(owner, out.eventId);
    assert.equal(await onSchedule(), false);
    await removeMeetingFromSchedule(owner, out.eventId);
  });

  if (failures) {
    console.error(`meet schedule (real store): ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet schedule (real store): all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
