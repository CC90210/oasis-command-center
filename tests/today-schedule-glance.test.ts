/**
 * Today's schedule shows the viewer's own Schedule calendar, in time order
 * next to the meetings booked through the pipeline.
 *
 * WHY THIS EXISTS. The Today glance read only pipeline meetings and the
 * Google Calendar connection, so CC's time blocks never appeared there, and
 * "No meetings booked" read like a free day. This file pins:
 *   - calendarBlocksForDay: today's occurrences from the stored rows, expanded
 *     like /schedule, on a UTC server (all-day dates compared as dates);
 *   - loadTodayCalendar against real libSQL: private to the viewer, never
 *     creates a calendar just because Today was opened, and a failed read is
 *     a failure, not an empty day;
 *   - ScheduleGlance: one list in time order, and the empty line only when
 *     both sources were read and both are empty;
 *   - every booked call stays listed and linked however many blocks the day
 *     holds (a shared 10-row cap cut the afternoon's calls once the routine
 *     was restored); past entries fold into an "earlier" line and the rest
 *     into "and N more", both opening /schedule;
 *   - a calendar kept outside Toronto is read on its own day and shown in
 *     its own zone, with every time naming its zone.
 *
 * Run: node --conditions=react-server --import tsx tests/today-schedule-glance.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";

process.env.TZ = "UTC";
const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "today-schedule-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.OPERATOR_TIMEZONE; // America/Toronto, the operator default
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/link", {
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
});
const hookOnly = () => {
  throw new Error("client hook called under react-server");
};
stub("next/navigation", { __esModule: true, useRouter: hookOnly, usePathname: hookOnly, useSearchParams: hookOnly, notFound: hookOnly, redirect: hookOnly });

const NOT_TEXT = new Set(["className", "id", "role", "style", "key", "href"]);
function walk(node: unknown, out: { text: string[]; hrefs: string[] } = { text: [], hrefs: [] }, depth = 0) {
  if (depth > 80 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function") return walk((node.type as (p: unknown) => unknown)(props), out, depth + 1);
    if (typeof props.href === "string") out.hrefs.push(props.href);
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") walk(v as ReactNode, out, depth + 1);
      else if (typeof v === "string" && !NOT_TEXT.has(k)) out.text.push(v);
    }
  }
  return out;
}
const render = (el: unknown) => {
  const w = walk(el);
  return { text: w.text.join(" ").replace(/\s+/g, " "), hrefs: w.hrefs };
};

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || String(e)).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CC = { tenantId: OASIS, userId: "0d000000-0000-4000-8000-000000000001" };
const OTHER = { tenantId: OASIS, userId: "0d000000-0000-4000-8000-000000000002" };
const wall = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

async function main() {
  assert.equal(new Date("2026-07-01T12:00:00Z").getTimezoneOffset(), 0, "precondition: UTC, like the Worker");
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/186_calendar.turso.sql"), "utf8"));

  const { operatorDateKey, operatorDayStartIso } = await import("../lib/dates");
  const dayOf = (iso: string) => {
    const at = new Date(iso);
    return { nowMs: at.getTime(), startMs: Date.parse(operatorDayStartIso(at)), endMs: Date.parse(operatorDayStartIso(at, 1)), todayKey: operatorDateKey(at) };
  };
  const loaders = await import("../components/os/today/loaders");
  const { ScheduleGlance } = await import("../components/os/today/ScheduleGlance");
  const routine = await import("../lib/calendar/routine");
  const store = await import("../lib/calendar/store");
  const { DEFAULT_PREFS } = await import("../lib/calendar/types");
  type EventRecord = import("../lib/calendar/types").EventRecord;
  type CalendarRecord = import("../lib/calendar/types").CalendarRecord;

  const cal = (id: string, visible = true): CalendarRecord => ({ id, name: id, color: "tide", visible, isDefault: id === "cal", position: 0, createdAt: "", updatedAt: "" });
  const plan = routine.buildRoutineSeries(routine.routineBlocks(), { calendarId: "cal", prefs: DEFAULT_PREFS, from: new Date("2026-09-30T16:00:00Z") });
  const rows: EventRecord[] = [...plan.series, ...plan.singles].map(({ event }, i) => ({ ...event, id: `r${i}`, createdAt: "", updatedAt: "" }));
  const ROUTINE_ORDER = ["Wake up", "Praying", "Run", "Abs", "Breakfast", "Eating", "Client fulfillment", "Internal systems", "Agent training / R&D"];

  await check("calendarBlocksForDay: a Wednesday lists the nine routine blocks in time order, at Montréal times", () => {
    const blocks = loaders.calendarBlocksForDay(rows, [cal("cal")], dayOf("2026-09-30T16:00:00Z"));
    assert.deepEqual(blocks.map((b) => b.title), ROUTINE_ORDER);
    assert.deepEqual([wall(blocks[0].startMs), wall(blocks[0].endMs)], ["06:30", "07:00"]);
    assert.deepEqual([wall(blocks[8].startMs), wall(blocks[8].endMs)], ["15:30", "17:00"]);
  });

  await check("calendarBlocksForDay: winter Fridays show the shortened or left-out R&D block; Saturday is empty", () => {
    const jan = loaders.calendarBlocksForDay(rows, [cal("cal")], dayOf("2027-01-15T17:00:00Z"));
    assert.equal(jan.length, 9);
    assert.deepEqual([wall(jan[8].startMs), wall(jan[8].endMs)], ["15:30", "16:00"], "ends 18 min before 4:18pm candles");
    const dec = loaders.calendarBlocksForDay(rows, [cal("cal")], dayOf("2026-12-18T17:00:00Z"));
    assert.deepEqual(dec.map((b) => b.title), ROUTINE_ORDER.slice(0, 8), "under 15 minutes left: R&D is not on Dec 18");
    assert.equal(loaders.calendarBlocksForDay(rows, [cal("cal")], dayOf("2026-10-03T16:00:00Z")).length, 0, "nothing on Saturday");
  });

  await check("calendarBlocksForDay: all-day events count by date on a UTC server; hidden calendars are left out", () => {
    const base = { ...rows[0], recurrence: null, exdates: [], allDay: true, timeZone: "America/Toronto" };
    const today: EventRecord = { ...base, id: "a1", title: "Offsite", start: "2026-09-30", end: "2026-10-01" };
    const tomorrow: EventRecord = { ...base, id: "a2", title: "Tomorrow", start: "2026-10-01", end: "2026-10-02" };
    const hidden: EventRecord = { ...rows[0], id: "h1", calendarId: "side", title: "Hidden" };
    const blocks = loaders.calendarBlocksForDay([today, tomorrow, hidden], [cal("cal"), cal("side", false)], dayOf("2026-09-30T23:30:00Z"));
    assert.deepEqual(blocks.map((b) => [b.title, b.allDay]), [["Offsite", true]]);
  });

  const TORONTO = "America/Toronto";
  const emptyDay = (iso: string) => ({ ok: true, value: { blocks: [], partial: false, asOfMs: Date.parse(iso), timeZone: TORONTO } });

  await check("loadTodayCalendar: a viewer with no calendar reads an empty day and nothing is created", async () => {
    const read = await loaders.loadTodayCalendar(CC, dayOf("2026-09-30T16:00:00Z"));
    assert.deepEqual(read, emptyDay("2026-09-30T16:00:00Z"));
    const n = Number((await raw.execute("SELECT count(*) AS n FROM calendar_calendars")).rows[0].n);
    assert.equal(n, 0, "looking at Today wrote no calendar");
  });

  await check("loadTodayCalendar: after the routine is restored, today's blocks; another user sees none of them", async () => {
    const restored = await store.restoreRoutine(CC, { blocks: routine.routineBlocks(), now: new Date("2026-09-30T16:00:00Z") });
    assert.equal(restored.status, "restored");
    const read = await loaders.loadTodayCalendar(CC, dayOf("2026-09-30T16:00:00Z"));
    assert.ok(read.ok);
    assert.deepEqual(read.value.blocks.map((b) => b.title), ROUTINE_ORDER);
    assert.equal(read.value.timeZone, TORONTO, "the routine is kept in Montréal time");
    assert.equal(read.value.asOfMs, Date.parse("2026-09-30T16:00:00Z"));
    const other = await loaders.loadTodayCalendar(OTHER, dayOf("2026-09-30T16:00:00Z"));
    assert.deepEqual(other, emptyDay("2026-09-30T16:00:00Z"));
  });

  await check("calendarZone: the zone most timed events carry; a tie with the operator's zone, or no event, is the operator's", () => {
    const ev = (id: string, timeZone: string, allDay = false): EventRecord => ({ ...rows[0], id, timeZone, allDay });
    assert.equal(loaders.calendarZone([]), TORONTO);
    assert.equal(loaders.calendarZone([ev("a", "America/Vancouver"), ev("b", "America/Vancouver"), ev("c", TORONTO)]), "America/Vancouver");
    assert.equal(loaders.calendarZone([ev("a", "America/Vancouver"), ev("c", TORONTO)]), TORONTO);
    assert.equal(loaders.calendarZone([ev("a", "Europe/Paris", true)]), TORONTO, "all-day rows carry no clock time");
    assert.equal(loaders.calendarZone([ev("a", "Not/AZone"), ev("b", "Not/AZone")]), TORONTO, "an unknown zone is never used");
  });

  await check("loadTodayCalendar: a calendar kept in Vancouver is read on Vancouver's day, not Toronto's", async () => {
    // Wed 2026-09-30 23:30 in Vancouver is already Thu 02:30 in Toronto.
    const VAN = { tenantId: "7c7c7c7c-0000-4000-8000-00000000007c", userId: "0d000000-0000-4000-8000-000000000003" };
    const [calendar] = await store.listCalendars(VAN);
    const base = { ...plan.series[0].event, calendarId: calendar.id, timeZone: "America/Vancouver", exdates: [], color: null };
    await store.applyOps(
      VAN,
      [
        { op: "create", event: { ...base, title: "Standup", start: "2026-09-28T16:00:00.000Z", end: "2026-09-28T16:30:00.000Z", recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [1, 2, 3, 4, 5] } } },
        { op: "create", event: { ...base, title: "Late review", start: "2026-10-01T05:00:00.000Z", end: "2026-10-01T05:30:00.000Z", recurrence: null } },
      ],
      await store.getPrefs(VAN),
    );
    const now = "2026-10-01T06:30:00Z";
    const read = await loaders.loadTodayCalendar(VAN, dayOf(now));
    assert.ok(read.ok);
    assert.equal(read.value.timeZone, "America/Vancouver");
    assert.deepEqual(
      read.value.blocks.map((b) => [b.title, new Date(b.startMs).toISOString()]),
      [["Standup", "2026-09-30T16:00:00.000Z"], ["Late review", "2026-10-01T05:00:00.000Z"]],
      "Wednesday's 9am standup and 10pm review, not Thursday's standup",
    );
  });

  await check("loadTodayCalendar: a failed read is { ok: false }, never an empty day", async () => {
    await raw.execute("ALTER TABLE calendar_events RENAME TO calendar_events_moved");
    try {
      const origError = console.error;
      console.error = () => undefined; // the loader logs the cause; keep the test output readable
      try {
        assert.deepEqual(await loaders.loadTodayCalendar(CC, dayOf("2026-09-30T16:00:00Z")), { ok: false });
      } finally {
        console.error = origError;
      }
    } finally {
      await raw.execute("ALTER TABLE calendar_events_moved RENAME TO calendar_events");
    }
  });

  // ── The glance ────────────────────────────────────────────────────────────
  const status = { ok: true as const, value: { personal: { connected: false, label: "Not connected", address: null }, workspace: null } };
  const at = (hhmm: string) => Date.parse(`2026-09-30T${hhmm}:00-04:00`);
  const block = (title: string, s: string, e: string) => ({ key: title, title, startMs: at(s), endMs: at(e), allDay: false });
  type Block = ReturnType<typeof block>;
  /** A read calendar day, as loadTodayCalendar returns it; read at 05:00 Toronto unless said otherwise. */
  const readDay = (blocks: Block[], extra: { partial?: boolean; asOf?: string; timeZone?: string } = {}) => ({
    ok: true as const,
    value: { blocks, partial: extra.partial ?? false, asOfMs: at(extra.asOf ?? "05:00"), timeZone: extra.timeZone ?? TORONTO },
  });
  const glance = (p: Partial<Parameters<typeof ScheduleGlance>[0]>) =>
    render(createElement(ScheduleGlance, { blocks: null, meetings: null, partial: false, calendar: status, connectHref: "/settings", ...p }));

  await check("ScheduleGlance: calendar blocks and booked meetings in one list, in time order", () => {
    const out = glance({
      blocks: readDay([block("Client fulfillment", "10:00", "13:00"), block("Wake up", "06:30", "07:00")]),
      meetings: { ok: true, value: [{ id: "lead-1", name: "Acme Plumbing", at: at("11:00") }] },
    });
    const order = ["Wake up", "Client fulfillment", "Acme Plumbing"].map((t) => out.text.indexOf(t));
    assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], out.text);
    assert.match(out.text, /6:30 AM Wake up to 7:00 AM/);
    assert.match(out.text, /11:00 AM Acme Plumbing Booked call/);
    assert.doesNotMatch(out.text, /\b(EDT|EST)\b/, "a calendar kept in the operator's zone names no zone");
    assert.ok(out.hrefs.includes("/pipeline/lead-1") && out.hrefs.filter((h) => h === "/schedule").length >= 3);
    assert.doesNotMatch(out.text, /Nothing on your Schedule|No meetings booked/);
  });

  // The restored routine's nine weekday blocks, exactly as Today reads them.
  const ROUTINE_DAY: Block[] = [
    block("Wake up", "06:30", "07:00"),
    block("Praying", "07:00", "07:30"),
    block("Run", "07:30", "08:15"),
    block("Abs", "08:15", "08:45"),
    block("Breakfast", "08:45", "09:30"),
    block("Eating", "09:30", "10:00"),
    block("Client fulfillment", "10:00", "13:00"),
    block("Internal systems", "13:30", "15:00"),
    block("Agent training / R&D", "15:30", "17:00"),
  ];
  const lateCalls = { ok: true as const, value: [{ id: "acme", name: "Acme", at: at("14:00") }, { id: "globex", name: "Globex", at: at("16:00") }] };

  await check("ScheduleGlance: with the routine restored, every booked call is still listed and linked", () => {
    const out = glance({ blocks: readDay(ROUTINE_DAY), meetings: lateCalls });
    assert.match(out.text, /2:00 PM Acme Booked call/);
    assert.match(out.text, /4:00 PM Globex Booked call/, "the afternoon call is not cut by the routine's blocks");
    assert.ok(out.hrefs.includes("/pipeline/acme") && out.hrefs.includes("/pipeline/globex"), out.hrefs.join(" "));
    for (const b of ROUTINE_DAY) assert.ok(out.text.includes(b.title), `${b.title} is listed before the day starts`);
    assert.doesNotMatch(out.text, /earlier|more on your Schedule/);
  });

  await check("ScheduleGlance: entries already over fold into one 'earlier' line that opens /schedule", () => {
    const out = glance({ blocks: readDay(ROUTINE_DAY, { asOf: "12:00" }), meetings: lateCalls });
    assert.match(out.text, /6 earlier on your Schedule today/);
    for (const past of ["Wake up", "Praying", "Run", "Abs", "Breakfast", "Eating"]) assert.ok(!out.text.includes(past), `${past} is folded`);
    assert.match(out.text, /10:00 AM Client fulfillment to 1:00 PM .*2:00 PM Acme Booked call .*3:30 PM Agent training \/ R&D .*4:00 PM Globex Booked call/);
    assert.equal(out.hrefs.filter((h) => h === "/schedule").length, 5, "header + the earlier line + the three blocks still to come");
    const done = glance({ blocks: readDay(ROUTINE_DAY, { asOf: "18:00" }), meetings: { ok: true, value: [] } });
    assert.match(done.text, /9 earlier on your Schedule today/);
    assert.doesNotMatch(done.text, /Nothing on your Schedule/, "a day whose blocks are over is not an empty day");
  });

  await check("ScheduleGlance: past ten entries still to come, 'and N more' opens /schedule; meetings are never capped", () => {
    const many = Array.from({ length: 14 }, (_, i) => block(`Block ${i + 1}`, `${String(6 + i).padStart(2, "0")}:00`, `${String(6 + i).padStart(2, "0")}:30`));
    const calls = { ok: true as const, value: ["a", "b", "c"].map((id, i) => ({ id, name: `Call ${id}`, at: at(`${17 + i}:45`) })) };
    const out = glance({ blocks: readDay(many), meetings: calls });
    assert.ok(out.text.includes("Block 10") && !out.text.includes("Block 11"), out.text);
    assert.match(out.text, /and 4 more on your Schedule today/);
    for (const id of ["a", "b", "c"]) assert.ok(out.hrefs.includes(`/pipeline/${id}`), `call ${id} is linked`);
    assert.equal(out.hrefs.filter((h) => h === "/schedule").length, 12, "header + ten entries + the 'more' line");
  });

  await check("ScheduleGlance: a calendar kept in another zone shows its times there, and every time names its zone", () => {
    const standup = { key: "s", title: "Standup", startMs: Date.parse("2026-09-30T09:00:00-07:00"), endMs: Date.parse("2026-09-30T09:30:00-07:00"), allDay: false };
    const out = glance({
      blocks: { ok: true, value: { blocks: [standup], partial: false, asOfMs: Date.parse("2026-09-30T06:00:00-07:00"), timeZone: "America/Vancouver" } },
      meetings: { ok: true, value: [{ id: "acme", name: "Acme", at: at("14:00") }] },
    });
    assert.match(out.text, /9:00 AM PDT Standup to 9:30 AM/, "Vancouver's 9am, named");
    assert.doesNotMatch(out.text, /12:00 PM Standup/, "never Toronto's clock for a Vancouver entry");
    assert.match(out.text, /2:00 PM EDT Acme Booked call/, "the meeting names Toronto's zone");
  });

  await check("ScheduleGlance: the empty line appears only when both sources were read and both are empty", () => {
    const both = glance({ blocks: readDay([]), meetings: { ok: true, value: [] } });
    assert.match(both.text, /Nothing on your Schedule today, and no meetings booked through the pipeline today\./);
    const blocksOnly = glance({ blocks: readDay([block("Run", "07:30", "08:15")]), meetings: { ok: true, value: [] } });
    assert.doesNotMatch(blocksOnly.text, /Nothing on your Schedule/);
    assert.match(blocksOnly.text, /Run/);
    const meetingOnly = glance({ blocks: readDay([]), meetings: { ok: true, value: [{ id: "l", name: "Lead", at: at("09:00") }] } });
    assert.doesNotMatch(meetingOnly.text, /Nothing on your Schedule/);
  });

  await check("ScheduleGlance: a failed or incomplete read is never 'nothing today'", () => {
    const failed = glance({ blocks: { ok: false }, meetings: { ok: true, value: [] } });
    assert.match(failed.text, /Couldn.t load your Schedule for today\./);
    assert.doesNotMatch(failed.text, /Nothing on your Schedule/);
    assert.match(failed.text, /No meetings booked through the pipeline today\./, "what is known is still said");
    const partialRead = glance({ blocks: readDay([], { partial: true }), meetings: { ok: true, value: [] } });
    assert.doesNotMatch(partialRead.text, /Nothing on your Schedule/);
    assert.match(partialRead.text, /Only your first 5,000 calendar events were read/);
    const meetingsFailed = glance({ blocks: readDay([]), meetings: { ok: false } });
    assert.match(meetingsFailed.text, /Couldn.t load today.s booked meetings\./);
    assert.match(meetingsFailed.text, /^(?!.*and no meetings).*Nothing on your Schedule today\./);
    const noPipeline = glance({ blocks: readDay([]), meetings: null });
    assert.match(noPipeline.text, /Nothing on your Schedule today\./);
    assert.doesNotMatch(noPipeline.text, /pipeline/);
  });

  await check("Today (FounderToday) reads the viewer's calendar with the session's workspace and user, and hands it to the glance", () => {
    const src = readFileSync(join(ROOT, "components/today/FounderToday.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.match(src, /loadTodayCalendar\(\{ tenantId, userId: viewer\.userId \}, day\)/);
    assert.match(src, /schedule=\{\{\s*blocks,/);
  });

  raw.close();
  if (failures) {
    console.error(`today-schedule-glance: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("today-schedule-glance: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
