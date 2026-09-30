/**
 * The weekly routine restore and workspace-aware calendar defaults.
 *
 * WHY THIS EXISTS. The database calendar that replaced the old Schedule page
 * (PR #486) started empty, so CC's daily time blocks vanished on every device;
 * the only way back was a per-browser localStorage import that dropped the
 * Friday R&D block for the whole year because some winter Fridays meet
 * Shabbat. And every workspace, clients included, was handed Montréal and the
 * Shabbat lock as defaults. This file pins:
 *
 *   1. buildRoutineSeries: Sunday-to-Thursday series and Friday series with
 *      the exact old times, in America/Toronto, on a UTC server;
 *   2. no occurrence of the restored routine (or of the legacy import) meets a
 *      Shabbat window across the whole planned horizon, winter Fridays
 *      included, and every row passes the server's own Shabbat check;
 *   3. POST /api/calendar/routine against real libSQL and a real signed
 *      session: OASIS only, cross-origin refused, edited times applied and
 *      validated, idempotent (already_restored), and race-safe;
 *   4. defaults: OASIS keeps Montréal + the lock, every other workspace has
 *      neither until the user sets them, and a saved row always wins.
 *
 * Run: node --conditions=react-server --import tsx tests/calendar-routine.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The Worker runs in UTC; the routine must still land on Montréal wall time.
process.env.TZ = "UTC";
const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "calendar-routine-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "calendar-routine-test-secret-that-is-long-enough-01";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "7c7c7c7c-0000-4000-8000-00000000007c";

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"),
  adon: u(2, "adon@oasisai.work"),
  clientOwner: u(3, "owner@client.test"),
} as const;
type Who = keyof typeof USERS;

async function login(who: Who | null) {
  if (!who) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: USERS[who].id, email: USERS[who].email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

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

const ORIGIN = "https://oasisai.test";
const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/calendar/routine`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-host": new URL(ORIGIN).host },
    body: JSON.stringify(body),
  });

/** Wall-clock "HH:MM" of an instant in Montréal. */
const wall = (d: Date | string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));
const wallDay = (d: Date | string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", weekday: "short" }).format(new Date(d));

/** The old Schedule page's routine, exactly (lib/schedule/model.ts createPlaceholderSchedule). */
const EXPECTED: [key: string, title: string, start: string, end: string][] = [
  ["wake-up", "Wake up", "06:30", "07:00"],
  ["praying", "Praying", "07:00", "07:30"],
  ["run", "Run", "07:30", "08:15"],
  ["abs", "Abs", "08:15", "08:45"],
  ["breakfast", "Breakfast", "08:45", "09:30"],
  ["eating", "Eating", "09:30", "10:00"],
  ["work-clients", "Client fulfillment", "10:00", "13:00"],
  ["work-systems", "Internal systems", "13:30", "15:00"],
  ["work-rnd", "Agent training / R&D", "15:30", "17:00"],
];

async function main() {
  assert.equal(new Date("2026-07-01T12:00:00Z").getTimezoneOffset(), 0, "precondition: runs in UTC like the Worker");
  const routine = await import("../lib/calendar/routine");
  const { createPlaceholderSchedule } = await import("../lib/schedule/model");
  const types = await import("../lib/calendar/types");
  const { DEFAULT_PREFS, NEUTRAL_PREFS, defaultPrefsFor, OASIS_HOME_TENANT_ID } = types;
  type EventInput = import("../lib/calendar/types").EventInput;
  type EventRecord = import("../lib/calendar/types").EventRecord;
  const { expandOccurrences } = await import("../lib/calendar/recurrence");
  const { overlapsShabbat, shabbatForWeekOf } = await import("../lib/calendar/sun");
  const { shabbatConflict, validateEventInput, validatePrefs } = await import("../lib/calendar/validate");

  const record = (e: EventInput, id: string): EventRecord => ({ ...e, id, createdAt: "", updatedAt: "" });
  const FROM = new Date("2026-09-30T16:00:00Z"); // a Wednesday in Montréal

  // ── 1. The series, with the exact old times ────────────────────────────
  await check("buildRoutineSeries: one Sunday-Thursday series and one Friday series per block, exact times, Montréal zone", () => {
    const plan = routine.buildRoutineSeries(createPlaceholderSchedule(FROM), { calendarId: "cal", prefs: DEFAULT_PREFS, from: FROM });
    assert.deepEqual(routine.routineBlocks().map((b) => [b.key, b.title, b.weekdays.join("")]), EXPECTED.map(([k, t]) => [k, t, "012345"]));
    for (const [key, title, start, end] of EXPECTED) {
      const week = plan.series.find((s) => s.key === `sun-thu:${key}`);
      assert.ok(week, `sun-thu:${key}`);
      assert.equal(week.event.title, title);
      assert.equal(week.event.timeZone, "America/Toronto");
      assert.deepEqual(week.event.recurrence?.byWeekday, [0, 1, 2, 3, 4], `${title} repeats Sunday to Thursday`);
      assert.equal(week.event.recurrence?.freq, "WEEKLY");
      assert.equal(wallDay(week.event.start), "Sun", `${title} starts on the week's Sunday`);
      assert.equal(wall(week.event.start), start, `${title} starts at ${start} Montréal`);
      assert.equal(wall(week.event.end), end, `${title} ends at ${end} Montréal`);
      assert.equal(week.event.recurrence?.until, undefined, `${title} Sun-Thu is not bounded`);
      assert.deepEqual(week.event.exdates, []);
      const fri = plan.series.find((s) => s.key === `fri:${key}`);
      assert.ok(fri, `fri:${key} exists (Friday is its own series, never dropped)`);
      assert.deepEqual(fri.event.recurrence?.byWeekday, [5]);
      assert.equal(wallDay(fri.event.start), "Fri");
      assert.equal(wall(fri.event.start), start);
      assert.equal(wall(fri.event.end), end);
    }
    assert.equal(plan.series.length, 18);
    assert.equal(plan.series.filter((s) => !s.key.startsWith("sun-thu") && !s.key.startsWith("fri")).length, 0, "nothing on Saturday");
    assert.deepEqual(plan.dropped, []);
    // Only the Friday R&D block (15:30-17:00) meets winter Shabbat in Montréal.
    assert.deepEqual(plan.adjusted.map((a) => a.key), ["fri:work-rnd"]);
    const rnd = plan.series.find((s) => s.key === "fri:work-rnd")!.event;
    assert.ok(rnd.recurrence?.until, "the adjusted Friday series ends at the planned horizon");
    assert.ok(rnd.exdates.length > 0);
    assert.ok(plan.singles.length > 0 && plan.singles.every((s) => s.key.startsWith("fri:work-rnd:")));
  });

  await check("A shortened Friday ends exactly 18 minutes before that Friday's candle-lighting", () => {
    const plan = routine.buildRoutineSeries(createPlaceholderSchedule(FROM), { calendarId: "cal", prefs: DEFAULT_PREFS, from: FROM });
    for (const { event } of plan.singles) {
      assert.equal(wall(event.start), "15:30");
      assert.equal(wallDay(event.start), "Fri");
      const candles = shabbatForWeekOf(new Date(event.start), DEFAULT_PREFS).start.getTime();
      const expected = Math.floor((candles - 18 * 60_000) / 60_000) * 60_000;
      assert.equal(Date.parse(event.end), expected, `${event.start}: ends 18 min before candles`);
      assert.ok(Date.parse(event.end) - Date.parse(event.start) >= 15 * 60_000);
      assert.equal(event.recurrence, null);
    }
    // Mid-January candle-lighting is ~4:18pm: R&D runs 3:30 to 4:00.
    const jan = plan.singles.find((s) => s.event.start.startsWith("2027-01-15"));
    assert.ok(jan, "Jan 15 2027 is a shortened week");
    assert.deepEqual([wall(jan.event.start), wall(jan.event.end)], ["15:30", "16:00"]);
    // Mid-December it is ~3:54pm: 3:30 to 3:36 is under 15 minutes, so that
    // week is left out (an exception date with no single in its place).
    const rnd = plan.series.find((s) => s.key === "fri:work-rnd")!.event;
    const dec18 = rnd.exdates.find((x) => x.startsWith("2026-12-18"));
    assert.ok(dec18, "Dec 18 2026 is taken out of the series");
    assert.ok(!plan.singles.some((s) => s.event.start === dec18), "and nothing is written in its place");
    const adj = plan.adjusted.find((a) => a.key === "fri:work-rnd")!;
    assert.equal(adj.shortened + adj.skipped, rnd.exdates.length, "every week taken out is shortened or named as left out");
    assert.equal(adj.shortened, plan.singles.length);
  });

  // ── 2. Shabbat, across the whole horizon, from several starting weeks ────
  for (const from of ["2026-09-30T16:00:00Z", "2026-12-16T17:00:00Z", "2027-03-10T17:00:00Z", "2027-06-16T16:00:00Z"]) {
    await check(`No restored occurrence meets Shabbat for ${routine.SHABBAT_PLAN_WEEKS} weeks from ${from.slice(0, 10)}, and the server's check passes every row`, () => {
      const start = new Date(from);
      const plan = routine.buildRoutineSeries(createPlaceholderSchedule(start), { calendarId: "cal", prefs: DEFAULT_PREFS, from: start });
      const rows = [...plan.series, ...plan.singles];
      rows.forEach(({ key, event }) => {
        assert.ok(validateEventInput(event).ok, `${key} is a valid event`);
        assert.equal(shabbatConflict(event, DEFAULT_PREFS), null, `${key} passes the server's Shabbat check`);
      });
      const records = rows.map(({ event }, i) => record(event, `r${i}`));
      const until = new Date(start.getTime() + (routine.SHABBAT_PLAN_WEEKS + 2) * 7 * 86_400_000);
      const occ = expandOccurrences(records, new Date(start.getTime() - 7 * 86_400_000), until);
      let winterFridays = 0;
      for (const o of occ) {
        assert.equal(overlapsShabbat(o.start, o.end, DEFAULT_PREFS), null, `${o.event.title} ${o.start.toISOString()} overlaps Shabbat`);
        const month = new Date(o.start).getUTCMonth();
        if (wallDay(o.start) === "Fri" && (month === 11 || month === 0) && o.event.title === "Agent training / R&D") winterFridays++;
      }
      assert.ok(winterFridays >= 8, `winter Friday R&D weeks are kept (shortened), not dropped: ${winterFridays}`);
      // Every Friday R&D week inside the horizon is accounted for: kept whole,
      // shortened, or named as left out.
      const rnd = plan.adjusted.find((a) => a.key === "fri:work-rnd");
      assert.ok(rnd);
      const fridays = occ.filter((o) => o.event.title === "Agent training / R&D" && wallDay(o.start) === "Fri").length;
      assert.equal(fridays + rnd.skipped, routine.SHABBAT_PLAN_WEEKS, "one per Friday, none silently lost");
    });
  }

  await check("With the lock off (a client's default), Friday is one plain weekly series, nothing shortened", () => {
    const plan = routine.buildRoutineSeries(createPlaceholderSchedule(FROM), { calendarId: "cal", prefs: NEUTRAL_PREFS, from: FROM });
    assert.deepEqual(plan.adjusted, []);
    assert.deepEqual(plan.singles, []);
    assert.equal(plan.series.find((s) => s.key === "fri:work-rnd")?.event.recurrence?.until, undefined);
  });

  await check("Edit times: only known blocks and valid minutes; titles and days never come from the request", () => {
    const blocks = routine.routineBlocks();
    const ok = routine.applyRoutineTimes(blocks, [{ key: "wake-up", startMinute: 360, endMinute: 390 }]);
    assert.ok(ok.ok && ok.value.find((b) => b.key === "wake-up")?.startMinute === 360);
    assert.deepEqual(routine.applyRoutineTimes(blocks, [{ key: "nap", startMinute: 1, endMinute: 2 }]), { ok: false, error: "routine_block_unknown" });
    assert.deepEqual(routine.applyRoutineTimes(blocks, [{ key: "run", startMinute: 500, endMinute: 500 }]), { ok: false, error: "routine_time_invalid" });
    assert.deepEqual(routine.applyRoutineTimes(blocks, [{ key: "run", startMinute: 500, endMinute: 1500 }]), { ok: false, error: "routine_time_invalid" });
    assert.deepEqual(routine.applyRoutineTimes(blocks, [{ key: "run", startMinute: 1.5, endMinute: 500 }]), { ok: false, error: "routine_time_invalid" });
    assert.deepEqual(
      routine.applyRoutineTimes(blocks, [{ key: "run", startMinute: 400, endMinute: 450 }, { key: "run", startMinute: 400, endMinute: 450 }]),
      { ok: false, error: "routine_block_unknown" },
    );
    assert.deepEqual(routine.applyRoutineTimes(blocks, "x"), { ok: false, error: "routine_times_invalid" });
    const titled = routine.applyRoutineTimes(blocks, [{ key: "run", startMinute: 400, endMinute: 450, title: "Injected", weekdays: [6] }]);
    assert.ok(titled.ok);
    const run = titled.value.find((b) => b.key === "run")!;
    assert.deepEqual([run.title, run.weekdays.join("")], ["Run", "012345"]);
  });

  // ── 4. Defaults ──────────────────────────────────────────────────────────
  await check("Defaults: OASIS keeps Montréal + the lock; any other workspace has neither; the lock needs a place", async () => {
    const { OASIS_OPERATOR_TENANT_ID } = await import("../lib/platform-operator");
    assert.equal(OASIS_HOME_TENANT_ID, OASIS_OPERATOR_TENANT_ID, "one OASIS workspace id");
    assert.equal(defaultPrefsFor(OASIS).shabbatProtection, true);
    assert.equal(defaultPrefsFor(OASIS).location?.label, "Montréal");
    assert.equal(defaultPrefsFor(CLIENT).shabbatProtection, false);
    assert.equal(defaultPrefsFor(CLIENT).location, null);
    assert.equal((validatePrefs({ ...NEUTRAL_PREFS, shabbatProtection: true }) as { error: string }).error, "shabbat_needs_location");
    const partial = validatePrefs({ weekStartsOn: 1 }, NEUTRAL_PREFS);
    assert.ok(partial.ok && partial.value.location === null && partial.value.shabbatProtection === false, "missing keys come from the workspace's defaults");
    assert.ok(validatePrefs({ ...NEUTRAL_PREFS, location: null }).ok, "no location is valid");
    // No place: nothing to compute from. The Shabbat helpers neither throw nor
    // invent a city; if the lock were somehow on, the window fails closed.
    assert.equal(overlapsShabbat(new Date("2026-10-03T16:00:00Z"), new Date("2026-10-03T17:00:00Z"), NEUTRAL_PREFS), null);
    const closed = shabbatForWeekOf(new Date("2026-10-01T12:00:00Z"), { ...NEUTRAL_PREFS, shabbatProtection: true });
    assert.equal(closed.computed, false);
  });

  // ── 3. The routes, against real libSQL and a real session ───────────────
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, custom_fields TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
  `);
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/186_calendar.turso.sql"), "utf8"));
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["bravo"]', ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, stamp],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      profile("cc", OASIS, "owner", 1),
      profile("adon", OASIS, "admin", 0),
      profile("clientOwner", CLIENT, "owner", 1),
    ],
    "write",
  );

  const route = await import("../app/api/calendar/routine/route");
  const calendarRoute = await import("../app/api/calendar/route");
  const prefsRoute = await import("../app/api/calendar/prefs/route");
  const store = await import("../lib/calendar/store");
  const countEvents = async (userId: string) =>
    Number((await raw.execute({ sql: "SELECT count(*) AS n FROM calendar_events WHERE user_id = ?", args: [userId] })).rows[0].n);

  await check("GET: the OASIS owner is offered the routine, a client is told it is not available and sees no blocks", async () => {
    await login("cc");
    const cc = await (await route.GET()).json();
    assert.equal(cc.available, true);
    assert.equal(cc.restored, false);
    assert.deepEqual(cc.blocks.map((b: { title: string }) => b.title), EXPECTED.map(([, t]) => t));
    await login("clientOwner");
    const client = await (await route.GET()).json();
    assert.deepEqual(client, { ok: true, available: false });
    await login(null);
    assert.equal((await route.GET()).status, 401);
  });

  await check("POST: a client workspace is refused, and so is a cross-origin request; nothing is written", async () => {
    await login("clientOwner");
    const res = await route.POST(post({}));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "routine_not_available");
    assert.equal(await countEvents(USERS.clientOwner.id), 0);
    await login("cc");
    assert.equal((await route.POST(post({}, "https://evil.test"))).status, 403);
    assert.equal(await countEvents(USERS.cc.id), 0);
    const bad = await route.POST(post({ times: [{ key: "nap", startMinute: 1, endMinute: 2 }] }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "routine_block_unknown");
    assert.equal(await countEvents(USERS.cc.id), 0);
  });

  let restoredCount = 0;
  await check("POST: restores the routine into CC's default calendar with his edited times; the second call is already_restored", async () => {
    await login("cc");
    const res = await route.POST(post({ times: [{ key: "wake-up", startMinute: 360, endMinute: 390 }] }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "restored");
    const [personal] = await store.listCalendars({ tenantId: OASIS, userId: USERS.cc.id });
    assert.equal(body.calendarId, personal.id);
    assert.ok(personal.isDefault);
    restoredCount = body.created.length;
    assert.ok(restoredCount >= 18);
    assert.equal(await countEvents(USERS.cc.id), restoredCount);
    const { events } = await store.listEvents({ tenantId: OASIS, userId: USERS.cc.id });
    assert.ok(events.every((e) => e.id.startsWith(routine.ROUTINE_ID_PREFIX)), "every row carries the routine_v1 tag");
    assert.ok(events.every((e) => e.calendarId === personal.id));
    const wake = events.find((e) => e.title === "Wake up" && e.recurrence?.byWeekday?.join("") === "01234")!;
    assert.deepEqual([wall(wake.start), wall(wake.end)], ["06:00", "06:30"], "the edited time was used");
    const praying = events.find((e) => e.title === "Praying" && e.recurrence?.byWeekday?.join("") === "01234")!;
    assert.equal(wall(praying.start), "07:00", "unedited blocks keep the routine's time");
    const prefs = await store.getPrefs({ tenantId: OASIS, userId: USERS.cc.id });
    for (const e of events) assert.equal(shabbatConflict(e, prefs), null, `${e.title} as stored passes the Shabbat lock`);

    const again = await route.POST(post({}));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).status, "already_restored");
    assert.equal(await countEvents(USERS.cc.id), restoredCount, "the second call wrote nothing");
    assert.equal((await (await route.GET()).json()).restored, true);
  });

  await check("POST: two restores racing write the routine once", async () => {
    await login("adon");
    const [a, b] = await Promise.all([route.POST(post({})), route.POST(post({}))]);
    const statuses = [(await a.json()).status, (await b.json()).status].sort();
    assert.deepEqual(statuses, ["already_restored", "restored"]);
    const expected = routine.buildRoutineSeries(routine.routineBlocks(), { calendarId: "x", prefs: DEFAULT_PREFS, from: new Date() });
    assert.equal(await countEvents(USERS.adon.id), expected.series.length + expected.singles.length);
  });

  await check("The events route accepts edits to a restored series (the ids are ordinary ids)", async () => {
    await login("cc");
    const owner = { tenantId: OASIS, userId: USERS.cc.id };
    const { events } = await store.listEvents(owner);
    const rnd = events.find((e) => e.title === "Agent training / R&D" && e.recurrence?.byWeekday?.join("") === "5")!;
    await store.applyOps(owner, [{ op: "update", id: rnd.id, patch: { title: "R&D" } }], await store.getPrefs(owner));
    assert.equal((await store.listEvents(owner)).events.find((e) => e.id === rnd.id)?.title, "R&D");
  });

  await check("Prefs: OASIS gets Montréal + the lock, a client gets neither, and a saved row wins", async () => {
    await login("cc");
    const ccData = await (await calendarRoute.GET()).json();
    assert.equal(ccData.prefs.shabbatProtection, true);
    assert.equal(ccData.prefs.location.label, "Montréal");
    await login("clientOwner");
    const clientData = await (await calendarRoute.GET()).json();
    assert.equal(clientData.prefs.shabbatProtection, false, "a client is not defaulted to the Shabbat lock");
    assert.equal(clientData.prefs.location, null, "a client is not defaulted to Montréal");
    const put = (body: unknown) =>
      prefsRoute.PUT(new Request(`${ORIGIN}/api/calendar/prefs`, { method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-host": new URL(ORIGIN).host }, body: JSON.stringify(body) }));
    const refused = await put({ ...clientData.prefs, shabbatProtection: true });
    assert.equal(refused.status, 400, "the lock cannot be on without a place");
    const toronto = { label: "Toronto", lat: 43.6532, lon: -79.3832 };
    assert.equal((await put({ ...clientData.prefs, location: toronto, shabbatProtection: true })).status, 200);
    const saved = await store.getPrefs({ tenantId: CLIENT, userId: USERS.clientOwner.id });
    assert.deepEqual([saved.location?.label, saved.shabbatProtection], ["Toronto", true], "the client's own choice wins");
    await login("adon");
    assert.equal((await put({ ...DEFAULT_PREFS, shabbatProtection: false })).status, 200);
    assert.equal((await store.getPrefs({ tenantId: OASIS, userId: USERS.adon.id })).shabbatProtection, false, "an OASIS member's saved row wins too");
  });

  raw.close();
  if (failures) {
    console.error(`calendar-routine: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("calendar-routine: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
