/**
 * tests/booking-schedule-window.test.ts - public booking reads a host's
 * Schedule for the booking WINDOW, never capped by old history
 * (lib/calendar/store.ts listEventsBetween; Codex review of #628).
 *
 * listEvents returns the first 5,000 rows in start order. Availability fails
 * closed on a truncated read, so a long-lived or imported calendar with 5,000+
 * past events would have closed every slot for good. The window read returns
 * every repeating series and every edited occurrence (either can reach into
 * the window from outside it) plus the one-offs that overlap it.
 *
 * Runs against a real libSQL file built from migration 186.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(mkdtempSync(join(tmpdir(), "booking-window-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";

const TENANT = "tenant-a";
const CC = "user-cc";
const OTHER = "user-other";
const AT = "2026-01-01T00:00:00.000Z";

async function main(): Promise<void> {
  console.log("booking schedule window");
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync("database/turso/186_calendar.turso.sql", "utf8"));

  const insert = (id: string, user: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
    sql: `INSERT INTO calendar_events (id, tenant_id, user_id, calendar_id, start_at, end_at, time_zone,
            recurrence, recurring_event_id, original_start, all_day, created_at, updated_at)
          VALUES (?, ?, ?, 'cal', ?, ?, 'America/Toronto', ?, ?, ?, ?, ?, ?)`,
    args: [
      id, TENANT, user, start, end,
      (extra.recurrence as string | undefined) ?? null,
      (extra.recurring_event_id as string | undefined) ?? null,
      (extra.original_start as string | undefined) ?? null,
      (extra.all_day as number | undefined) ?? 0,
      AT, AT,
    ],
  });

  // 6,000 past one-off events: more than listEvents' 5,000-row cap on their own.
  const past = Array.from({ length: 6000 }, (_, i) => {
    const start = new Date(Date.parse("2025-01-01T15:00:00.000Z") + i * 3_600_000).toISOString();
    return insert(`old-${i}`, CC, start, new Date(Date.parse(start) + 1_800_000).toISOString());
  });
  for (let i = 0; i < past.length; i += 500) await raw.batch(past.slice(i, i + 500), "write");
  await raw.batch([
    // A weekly series that started long ago and still repeats into the window:
    // Mondays 14:00 Toronto (it repeats on wall time, so 18:00Z under EDT).
    insert("series-1", CC, "2025-06-02T18:00:00.000Z", "2025-06-02T19:00:00.000Z", {
      recurrence: JSON.stringify({ freq: "WEEKLY", interval: 1, byWeekday: [1] }),
    }),
    // An edited occurrence of that series.
    insert("override-1", CC, "2026-10-20T20:00:00.000Z", "2026-10-20T21:00:00.000Z", {
      recurring_event_id: "series-1",
      original_start: "2026-10-19T18:00:00.000Z",
    }),
    // A one-off inside the window, and an all-day one on its first day.
    insert("meeting-1", CC, "2026-10-21T15:00:00.000Z", "2026-10-21T16:00:00.000Z"),
    insert("allday-1", CC, "2026-10-16", "2026-10-17", { all_day: 1 }),
    // A one-off after the window, and someone else's event inside it.
    insert("later-1", CC, "2026-12-01T15:00:00.000Z", "2026-12-01T16:00:00.000Z"),
    insert("theirs-1", OTHER, "2026-10-21T15:00:00.000Z", "2026-10-21T16:00:00.000Z"),
  ], "write");

  const store = await import("../lib/calendar/store");
  const owner = { tenantId: TENANT, userId: CC };

  const whole = await store.listEvents(owner);
  assert.equal(whole.truncated, true, "precondition: the whole-history read is truncated");

  // The booking window, widened by a day each side as public-booking.ts does.
  const from = "2026-10-15T14:00:00.000Z";
  const to = "2026-10-29T14:30:00.000Z";
  const windowed = await store.listEventsBetween(owner, from, to);
  const ids = windowed.events.map((e) => e.id).sort();
  assert.equal(windowed.truncated, false, "6,000 past events must not truncate the window read");
  assert.deepEqual(ids, ["allday-1", "meeting-1", "override-1", "series-1"]);
  console.log("  ok - the window read returns the series, its edit, the overlapping one-offs; nothing old, later or someone else's");

  const { scheduleBusyIntervals } = await import("../lib/booking/schedule-busy");
  const busy = scheduleBusyIntervals(windowed.events, Date.parse(from), Date.parse(to), "America/Toronto")
    .map((b) => new Date(b.start).toISOString());
  assert.ok(busy.includes("2026-10-21T15:00:00.000Z"), "the one-off blocks its time");
  assert.ok(busy.includes("2026-10-26T18:00:00.000Z"), "the old series still blocks Monday Oct 26");
  assert.ok(busy.includes("2026-10-20T20:00:00.000Z"), "the edited occurrence blocks its new time");
  assert.ok(!busy.includes("2026-10-19T18:00:00.000Z"), "the edited occurrence's original time is free");
  console.log("  ok - those rows still become the right busy time");

  console.log("booking-schedule-window: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
