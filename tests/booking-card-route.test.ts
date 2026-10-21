/**
 * tests/booking-card-route.test.ts - the Schedule's Booking link card and /book
 * agree about each host's Google Calendar, through the real route.
 *
 * WHY THIS EXISTS. CC, 2026-10-17: the card said "Google Calendar: Not
 * connected. No times can be offered until it is connected." while /book WAS
 * offering times. The card answered from the person's own Google connection;
 * /book reads a host's calendar through listGoogleCalendarBusy, which also uses
 * the workspace calendar credential when that credential IS the host's own
 * Google account (production's is CC's).
 *
 * Real GET /api/calendar/booking, with the real session, roster, booking
 * settings and libSQL (tests/_delivery-harness.ts), and the real
 * listGoogleCalendarBusy. Only Google's two HTTP endpoints (token, events) are
 * stood in for, and every request is recorded. In each state one rule is
 * checked: a host's card says ready exactly when the read /book makes for that
 * host works. (tests/booking-host-calendar-status.test.ts pins the wording.)
 *
 * Also through the real route: the card's GET spends Google calls, so a host's
 * answer is kept for 30 seconds and a repeat load costs none; a Google outage
 * is not a refused sign-in; and a saved value that will not decrypt is "Status
 * unavailable", where /book (whose reader turns it into an empty bundle) treats
 * the host as not connected.
 *
 * Run: node --conditions=react-server --import tsx tests/booking-card-route.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OASIS, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

process.env.BRAVO_FIELD_ENCRYPTION_KEY = "booking-card-route-field-encryption-passphrase";
// Never let a test reach Google, whatever the developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^GOOGLE_/.test(key)) delete process.env[key];
}
const WORKSPACE_REFRESH = "workspace-refresh-token";
Object.assign(process.env, {
  // The workspace calendar credential is CC's own Google account, as in production.
  GOOGLE_SYSTEM_CALENDAR_CLIENT_ID: "workspace-client-id",
  GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET: "workspace-client-secret",
  GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN: WORKSPACE_REFRESH,
  GOOGLE_SYSTEM_CALENDAR_ADDRESS: USERS.cc.email,
  // The client a host's own sign-in is refreshed with.
  GOOGLE_CLIENT_ID: "rep-client-id",
  GOOGLE_CLIENT_SECRET: "rep-client-secret",
});

// -- Google, stood in for at its two endpoints ----------------------------------
type GoogleCall =
  | { kind: "token"; refreshToken: string }
  | { kind: "events"; bearer: string; calendar: string; minutes: number };
const googleCalls: GoogleCall[] = [];
// What Google answers when the workspace credential is refreshed: fine, refused for good, or down.
let workspaceToken: "ok" | "dead" | "down" = "ok";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    const refreshToken = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
    googleCalls.push({ kind: "token", refreshToken });
    if (workspaceToken === "dead" && refreshToken === WORKSPACE_REFRESH) {
      return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    if (workspaceToken === "down" && refreshToken === WORKSPACE_REFRESH) {
      return json(503, { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } });
    }
    return json(200, { access_token: `access-${refreshToken}`, expires_in: 3600 });
  }
  if (url.origin === "https://www.googleapis.com" && /^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(url.pathname)) {
    googleCalls.push({
      kind: "events",
      bearer: new Headers(init?.headers).get("authorization") ?? "",
      calendar: decodeURIComponent(url.pathname.split("/")[4]),
      minutes: (Date.parse(url.searchParams.get("timeMax") ?? "") - Date.parse(url.searchParams.get("timeMin") ?? "")) / 60_000,
    });
    return json(200, { items: [] });
  }
  throw new Error(`network disabled in test: ${url.origin}${url.pathname}`);
}) as typeof fetch;

async function logged<T>(fn: () => Promise<T>): Promise<{ value: T; calls: unknown[][] }> {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void calls.push(args);
  try {
    return { value: await fn(), calls };
  } finally {
    console.error = original;
  }
}

async function main() {
  const db = await setupDatabase();
  await db.executeMultiple(`
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, user_id TEXT, service TEXT, field_key TEXT, encrypted_value TEXT,
      last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, created_at TEXT, updated_at TEXT);
    CREATE UNIQUE INDEX "uic_key" ON user_integration_credentials (tenant_id, user_id, service, field_key);
  `);
  for (const migration of ["186_calendar.turso.sql", "bravo__227_booking_settings.sql"]) {
    await db.executeMultiple(readFileSync(join(__dirname, "..", "database", "turso", migration), "utf8"));
  }
  const { BOOK_FORM_SLUG } = await import("../lib/forms/public-booking-config");
  await db.execute({ sql: "INSERT INTO forms (tenant_id, slug, name, enabled) VALUES (?, ?, 'Book a call', 1)", args: [OASIS, BOOK_FORM_SLUG] });

  const route = await import("../app/api/calendar/booking/route");
  const { loadPublicBookingAvailability } = await import("../lib/forms/public-booking");
  const { GoogleCalendarIntegrationError, listGoogleCalendarBusy } = await import("../lib/integrations/google-calendar");
  const { setUserIntegrationBundle } = await import("../lib/user-integration-store");
  const { clearHostCalendarStatusCache } = await import("../lib/booking/host-calendar-status");
  await login(USERS.cc);

  type CardHost = { userId: string; role: string; calendar: { ready: boolean; kind: string; label: string } };
  /**
   * What the signed-in owner's card is told, host by host (the organizer first). The route keeps each host's
   * answer for 30 seconds, so every state below starts from nothing kept unless it asks to keep them.
   */
  async function cardHosts(options: { keep?: boolean } = {}) {
    if (!options.keep) clearHostCalendarStatusCache();
    const { value, calls } = await logged(async () => {
      const res = await route.GET();
      assert.equal(res.status, 200);
      return ((await res.json()) as { hosts: CardHost[] }).hosts;
    });
    return { hosts: value, logs: calls };
  }

  // Monday 12:00 in Toronto: the proprietor is on duty from the first slot.
  const NOW = Date.parse("2026-10-19T16:00:00.000Z");
  /** /book's availability, with the REAL Google read, recording how each host's read ended. */
  async function book() {
    const reads = new Map<string, string>();
    const settled: Promise<unknown>[] = [];
    const listGoogleBusy = ((args: Parameters<typeof listGoogleCalendarBusy>[0]) => {
      const read = listGoogleCalendarBusy(args);
      settled.push(
        read.then(
          () => reads.set(args.organizerUserId, "ok"),
          (error: unknown) => reads.set(args.organizerUserId, error instanceof GoogleCalendarIntegrationError ? error.code : "unexpected"),
        ),
      );
      return read;
    }) as typeof listGoogleCalendarBusy;
    // Availability logs an attendee it leaves off; that is its own business, not this test's output.
    const { value } = await logged(async () => {
      try {
        const slots = await loadPublicBookingAvailability({ tenantId: OASIS, durationMinutes: 15, now: NOW }, { listGoogleBusy, listScheduleEvents: async () => [] });
        return { slots, error: null as unknown };
      } catch (error) {
        return { slots: [] as Awaited<ReturnType<typeof loadPublicBookingAvailability>>, error: error as unknown };
      }
    });
    await Promise.all(settled);
    return { ...value, reads };
  }
  /** The rule: the card says ready exactly when the read /book makes for that host worked. */
  function agree(hosts: CardHost[], reads: Map<string, string>) {
    assert.equal(hosts.length, 1, "only the proprietor is an OASIS host");
    for (const host of hosts) {
      assert.equal(host.calendar.ready, reads.get(host.userId) === "ok", `${host.role}: card says "${host.calendar.label}", /book's read ended "${reads.get(host.userId)}"`);
    }
  }
  const hostIds = (slots: Array<{ hosts: Array<{ userId: string }> }>) => slots.map((slot) => slot.hosts.map((host) => host.userId));

  console.log("booking card, through the real route");

  await check("CC's case: the workspace credential is his account and he is the only live OASIS booking host", async () => {
    googleCalls.length = 0;
    const { hosts, logs } = await cardHosts();
    assert.deepEqual(
      hosts.map((h) => [h.role, h.calendar]),
      [
        ["organizer", { ready: true, kind: "workspace", label: `Connected through the workspace calendar (${USERS.cc.email})` }],
      ],
      `the card says ${JSON.stringify(hosts.map((h) => [h.role, h.calendar]))}`,
    );
    assert.deepEqual(logs, [], "a working read and a host who has not connected are not faults");
    // One token and one events read, for CC only.
    assert.deepEqual(googleCalls.map((c) => c.kind), ["token", "events"]);
    assert.deepEqual(googleCalls[0], { kind: "token", refreshToken: WORKSPACE_REFRESH });
    assert.deepEqual(googleCalls[1], { kind: "events", bearer: `Bearer access-${WORKSPACE_REFRESH}`, calendar: "primary", minutes: 15 });

    const offered = await book();
    assert.equal(offered.error, null, "/book offers times");
    assert.ok(offered.slots.length > 0);
    assert.ok(hostIds(offered.slots).every((ids) => ids.length === 1 && ids[0] === USERS.cc.id), "CC is the sole host");
    agree(hosts, offered.reads);
  });

  await check("Loading the card again inside 30 seconds spends no Google call at all (a loop of GETs cannot burn CC's Calendar quota); once the answer is forgotten it reads again", async () => {
    clearHostCalendarStatusCache();
    googleCalls.length = 0;
    const first = await cardHosts({ keep: true });
    const spent = googleCalls.length;
    assert.equal(spent, 2, "the first load made CC's token and events reads");
    for (let i = 0; i < 5; i++) {
      const again = await cardHosts({ keep: true });
      assert.deepEqual(again.hosts, first.hosts, "the same answer");
    }
    assert.equal(googleCalls.length, spent, "five more loads: not one more Google call");
    clearHostCalendarStatusCache();
    await cardHosts({ keep: true });
    assert.equal(googleCalls.length, spent + 2, "after the answer is forgotten the next load reads again");
  });

  await check("a former operator's saved Google connection cannot put them back on the booking card or calendar", async () => {
    const saved = await setUserIntegrationBundle(OASIS, USERS.adon.id, "gmail_oauth", {
      refresh_token: "adon-refresh-token",
      scope: "https://www.googleapis.com/auth/calendar.events",
      gmail_address: USERS.adon.email,
    });
    assert.ok(saved.ok);
    const { hosts } = await cardHosts();
    assert.deepEqual(
      hosts.map((h) => h.calendar),
      [
        { ready: true, kind: "workspace", label: `Connected through the workspace calendar (${USERS.cc.email})` },
      ],
      `the card says ${JSON.stringify(hosts.map((h) => h.calendar))}`,
    );
    const offered = await book();
    assert.equal(offered.error, null);
    assert.ok(hostIds(offered.slots).every((ids) => ids.length === 1 && ids[0] === USERS.cc.id), "the former operator stays absent");
    assert.equal(offered.reads.has(USERS.adon.id), false, "the former operator's calendar is not read");
    agree(hosts, offered.reads);
  });

  await check("The workspace credential is refused for good: CC's card says Sign-in expired and /book fails closed", async () => {
    workspaceToken = "dead";
    const { hosts, logs } = await cardHosts();
    assert.deepEqual(
      hosts.map((h) => h.calendar),
      [
        { ready: false, kind: "needs_connection", label: "Sign-in expired" },
      ],
      `the card says ${JSON.stringify(hosts.map((h) => h.calendar))}`,
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], "[calendar.booking.host-status]");
    assert.match(JSON.stringify(logs[0][1]), /token_refresh_failed/);
    const offered = await book();
    assert.ok(offered.error instanceof GoogleCalendarIntegrationError && offered.error.code === "token_refresh_failed", "/book fails closed with the organizer's reason");
    assert.deepEqual(offered.slots, []);
    agree(hosts, offered.reads);
  });

  await check("Google is down when the workspace credential is refreshed (a 503, not a refusal): CC's card says Status unavailable with no sign-in claim, and /book fails closed the same way", async () => {
    workspaceToken = "down";
    const { hosts, logs } = await cardHosts();
    assert.deepEqual(
      hosts.map((h) => h.calendar),
      [
        { ready: false, kind: "unavailable", label: "Status unavailable" },
      ],
      `the card says ${JSON.stringify(hosts.map((h) => h.calendar))}`,
    );
    assert.equal(logs.length, 1, "logged once");
    assert.match(JSON.stringify(logs[0][1]), /token_refresh_failed/);
    const offered = await book();
    assert.ok(offered.error instanceof GoogleCalendarIntegrationError && offered.error.code === "token_refresh_failed", "/book fails closed for the organizer");
    agree(hosts, offered.reads);
  });

  await check("a former operator's unreadable saved Google value is ignored by the sole-owner booking route", async () => {
    workspaceToken = "ok";
    // A value the field encryption cannot open (a rotated key, say), in place of his real tokens.
    await db.execute({ sql: "UPDATE user_integration_credentials SET encrypted_value = 'not-a-ciphertext' WHERE tenant_id = ? AND user_id = ?", args: [OASIS, USERS.adon.id] });
    const { hosts, logs } = await cardHosts();
    assert.deepEqual(
      hosts.map((h) => h.calendar),
      [
        { ready: true, kind: "workspace", label: `Connected through the workspace calendar (${USERS.cc.email})` },
      ],
      `the card says ${JSON.stringify(hosts.map((h) => h.calendar))}`,
    );
    const ours = logs.filter((l) => l[0] === "[calendar.booking.host-status]");
    assert.equal(ours.length, 0, "the former operator is not read by the card");
    const offered = await book();
    assert.equal(offered.reads.has(USERS.adon.id), false, "/book never reads the former operator");
    assert.ok(hostIds(offered.slots).every((ids) => ids.length === 1 && ids[0] === USERS.cc.id), "CC remains the sole host");
    agree(hosts, offered.reads);
  });

  finish("booking-card-route");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
