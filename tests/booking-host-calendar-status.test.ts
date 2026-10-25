/**
 * tests/booking-host-calendar-status.test.ts - the Schedule's Booking link card
 * says a host's Google Calendar is connected exactly when /book can read it.
 *
 * WHY THIS EXISTS. CC, 2026-10-17 (screenshots of /schedule): the card said
 * "Google Calendar: Not connected. No times can be offered until it is
 * connected." while /book WAS offering times. The status answered from the
 * person's own Google connection alone; availability also reads a host's
 * calendar through the workspace credential when that credential IS the host's
 * own Google account (production's is CC's). The status now comes from the same
 * call (lib/booking/host-calendar-status.ts), so:
 *
 *   1. a read that works is ready: the person's own label when their own
 *      connection is ready, else "Connected through the workspace calendar
 *      (address)", never a bare "Connected";
 *   2. a read that fails says why, in the words pinned below, and never falls
 *      back to the person's own connection. "Sign-in expired" is only for a
 *      grant Google refused (400 invalid_grant, /book's own rule); a timeout or
 *      a 5xx is "Status unavailable", and so is a "Not connected" the status
 *      reader cannot confirm (a credentials table that will not read);
 *   3. the read is made for each host's own address with the arguments
 *      availability passes (lib/forms/public-booking.ts), and the card's idea of
 *      "needs the host to connect" matches /book's idea of "leave the host off";
 *   4. each host's answer is kept for 30 seconds and one host's read may take 8
 *      seconds at most, because the card's GET now spends Google calls;
 *   5. the card warns for a host who needs to connect (Adon's true "Not
 *      connected" stays), says "could not be checked" without a "connect it" for
 *      a host it could not read, and shows the workspace route as a quiet line;
 *   6. the card fits the 248px sidebar and the settings dialog fits a phone, down
 *      to 320px (the clock icon goes below 360px; pinned in the real CSS).
 *
 * The read is injected: nothing here reaches Google or the database. The real
 * route, with only Google's endpoints stood in for, is tests/booking-card-route.test.ts.
 * Run: node --conditions=react-server --import tsx tests/booking-host-calendar-status.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "postcss";
import * as ReactNS from "react";
import { isValidElement, type ReactNode } from "react";
import { defaultOasisBookingSettings } from "../lib/booking/hours";
import { GoogleCalendarIntegrationError, type GoogleCalendarErrorCode } from "../lib/integrations/google-calendar";
import type { PersonalGoogleFact } from "../lib/os/connectors";

// Never let a test reach Google, whatever the developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^GOOGLE_/.test(key)) delete process.env[key];
}

const ROOT = join(__dirname, "..");
const TENANT = "tenant-oasis";
const CC = { userId: "user-cc", email: "conaugh@oasisai.work" };
const ADON = { userId: "user-adon", email: "adon@oasisai.work" };
const NOW = Date.parse("2026-10-17T15:00:00.000Z");

const OWN_READY: PersonalGoogleFact = { linked: true, calendarScope: true, address: CC.email, workEmail: CC.email };
const NOT_LINKED: PersonalGoogleFact = { linked: false, calendarScope: false, address: null, workEmail: CC.email };
const WRONG_ACCOUNT: PersonalGoogleFact = { linked: true, calendarScope: true, address: "cc.personal@gmail.com", workEmail: CC.email };
const NO_CALENDAR: PersonalGoogleFact = { linked: true, calendarScope: false, address: CC.email, workEmail: CC.email };

type Mod = typeof import("../lib/booking/host-calendar-status");
type Deps = import("../lib/booking/host-calendar-status").HostCalendarStatusDeps;
type ReadArgs = { tenantId: string; organizerUserId: string; expectedOrganizerEmail: string; timeMin: string; timeMax: string };

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  console.log(`  ok - ${name}`);
}

/**
 * Deps that record every call. `read` answers (or throws) the calendar read; `fact` is the person's own
 * connection; `clock` is the time the deps see (move `clock.at` to age the kept answers).
 */
function depsWith(
  opts: {
    read?: (args: ReadArgs) => Promise<unknown[]>;
    fact?: PersonalGoogleFact | (() => never);
    workspace?: string | null;
    deadlineMs?: number;
    cache?: Deps["cache"];
    clock?: { at: number };
  } = {},
) {
  const reads: ReadArgs[] = [];
  const factReads: Array<[string, string]> = [];
  const clock = opts.clock ?? { at: NOW };
  const deps: Deps = {
    listBusy: (async (args: ReadArgs) => {
      reads.push(args);
      return opts.read ? opts.read(args) : [];
    }) as unknown as Deps["listBusy"],
    readPersonalFact: (async (tenantId: string, userId: string) => {
      factReads.push([tenantId, userId]);
      return typeof opts.fact === "function" ? opts.fact() : (opts.fact ?? NOT_LINKED);
    }) as Deps["readPersonalFact"],
    workspaceAddress: () => (opts.workspace === undefined ? CC.email : opts.workspace),
    now: () => clock.at,
    cache: opts.cache ?? new Map(),
    deadlineMs: opts.deadlineMs ?? 5_000,
  };
  return { deps, reads, factReads, clock };
}

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

const fail = (code: GoogleCalendarErrorCode) => async (): Promise<never> => {
  throw new GoogleCalendarIntegrationError(code, `${code} (test)`);
};
const failWith = (error: unknown) => async (): Promise<never> => {
  throw error;
};

// The refresh failures /book tells apart (lib/forms/public-booking.ts isUnconnectedCalendar).
const deadGrant = () =>
  new GoogleCalendarIntegrationError("token_refresh_failed", 'Google access-token refresh failed: {"error":"invalid_grant","error_description":"Token has been expired or revoked."}', { httpStatus: 400 });
const googleDown = () => new GoogleCalendarIntegrationError("token_refresh_failed", "Google access-token refresh failed: backend error", { httpStatus: 503 });
const networkBlip = () => new GoogleCalendarIntegrationError("token_refresh_failed", "Google access-token refresh failed", { cause: new TypeError("fetch failed") });
const badRequest = () => new GoogleCalendarIntegrationError("token_refresh_failed", 'Google access-token refresh failed: {"error":"invalid_request"}', { httpStatus: 400 });
const bothRejected = (cause?: unknown) =>
  new GoogleCalendarIntegrationError("workspace_calendar_token_invalid", "the host's sign-in and the shared workspace token were both rejected", cause === undefined ? {} : { cause });

// -- A minimal hook runtime, so BookingLinkCard runs as the page runs it (no DOM) --
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require("react") as Record<string, unknown>;
let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
R.useState = (init: unknown) => {
  const own = slots;
  const i = cursor++;
  if (!(i in own)) own[i] = typeof init === "function" ? (init as () => unknown)() : init;
  return [own[i], (v: unknown) => (own[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(own[i]) : v)];
};
R.useCallback = (fn: unknown) => {
  cursor++;
  return fn;
};
R.useEffect = (fn: () => unknown) => {
  const i = cursor++;
  if (i in slots) return;
  slots[i] = true;
  effects.push(() => void fn());
};

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    out.push(el);
    elements(el.props.children as ReactNode, out);
  }
  return out;
}
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as unknown as El).props.children as ReactNode);
  return "";
}
const flat = (node: unknown) => textOf(node).replace(/\s+/g, " ").trim();

async function main(): Promise<void> {
  console.log("booking host calendar status");
  const { hostCalendarStatus, hostCalendarStatuses, WORKSPACE_CALENDAR_LABEL, HOST_STATUS_TTL_MS } = (await import("../lib/booking/host-calendar-status")) as Mod;

  const WORKSPACE = `${WORKSPACE_CALENDAR_LABEL} (${CC.email})`;
  const status = (over: Parameters<typeof depsWith>[0], host = CC) =>
    logged(async () => {
      const made = depsWith(over);
      return { ...made, result: await hostCalendarStatus({ tenantId: TENANT, ...host }, made.deps) };
    });

  // -- 1. A read that works ------------------------------------------------
  await check("own connection ready and the read works: ready, and the person's own label is kept", async () => {
    const { value, calls } = await status({ fact: OWN_READY });
    assert.deepEqual(value.result, { ready: true, kind: "connected", label: "Connected" });
    assert.deepEqual(calls, [], "nothing to log");
  });

  await check("no own connection but the read works (CC's case, the workspace credential is his account): ready, through the workspace, never a bare Connected", async () => {
    for (const [why, fact] of [
      ["nothing linked", NOT_LINKED],
      ["linked to another Google account", WRONG_ACCOUNT],
      ["linked without calendar permission", NO_CALENDAR],
    ] as const) {
      const { value, calls } = await status({ fact });
      assert.deepEqual(value.result, { ready: true, kind: "workspace", label: WORKSPACE }, why);
      assert.notEqual(value.result.label, "Connected", `${why}: never just Connected`);
      assert.deepEqual(calls, [], `${why}: a working read is not a fault`);
    }
    assert.equal(WORKSPACE, "Connected through the workspace calendar (conaugh@oasisai.work)");
  });

  await check("with no workspace address on hand the label still names the route and never prints null", async () => {
    const { value } = await status({ fact: NOT_LINKED, workspace: null });
    assert.deepEqual(value.result, { ready: true, kind: "workspace", label: WORKSPACE_CALENDAR_LABEL });
  });

  await check("the person's own connection cannot be read while the calendar reads: ready, no claim about whose sign-in, and logged", async () => {
    const { value, calls } = await status({
      fact: () => {
        throw new Error("profile read failed");
      },
    });
    assert.deepEqual(value.result, { ready: true, kind: "connected", label: "Calendar readable" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "[calendar.booking.host-status]");
    assert.match(JSON.stringify(calls[0][1]), /profile read failed/);
  });

  // -- 2. A read that fails ------------------------------------------------
  const failures: Array<[GoogleCalendarErrorCode, "needs_connection" | "unavailable", string]> = [
    ["calendar_scope_required", "needs_connection", "Needs calendar permission"],
    ["calendar_organizer_mismatch", "needs_connection", "Connected to a different Google account"],
    ["calendar_availability_failed", "unavailable", "Status unavailable"],
    ["google_oauth_config_missing", "unavailable", "Status unavailable"],
  ];
  for (const [code, kind, label] of failures) {
    await check(`a read that fails with ${code} says "${label}", is not ready, is logged, and never trusts the person's own connection`, async () => {
      // The person's own connection reads as ready: a failed read must still win.
      const { value, calls } = await status({ read: fail(code), fact: OWN_READY });
      assert.deepEqual(value.result, { ready: false, kind, label });
      assert.deepEqual(value.factReads, [], "the own-connection fact is not consulted for this failure");
      assert.equal(calls.length, 1, "any failure but 'not connected' is logged");
      assert.equal(calls[0][0], "[calendar.booking.host-status]");
      assert.match(JSON.stringify(calls[0][1]), new RegExp(code));
    });
  }

  await check("Not connected is confirmed with the status reader once: it answers, so the card says Not connected (a normal state, not logged)", async () => {
    const { value, calls } = await status({ read: fail("google_calendar_not_connected"), fact: NOT_LINKED });
    assert.deepEqual(value.result, { ready: false, kind: "needs_connection", label: "Not connected" });
    assert.deepEqual(value.factReads, [[TENANT, CC.userId]], "asked exactly once, for this host");
    assert.deepEqual(calls, []);
  });

  await check("Not connected is never said when the status reader cannot answer (a credentials table that will not read): Status unavailable, and logged", async () => {
    const { value, calls } = await status({
      read: fail("google_calendar_not_connected"),
      fact: () => {
        throw new Error("personal_integration_decrypt_failed");
      },
    });
    assert.deepEqual(value.result, { ready: false, kind: "unavailable", label: "Status unavailable" });
    assert.equal(calls.length, 1);
    assert.match(JSON.stringify(calls[0][1]), /personal_integration_decrypt_failed/);
  });

  await check("Sign-in expired is only for a grant Google refused (400 invalid_grant, /book's rule); a timeout, a network error, a 5xx or another 400 is Status unavailable", async () => {
    const cases: Array<[string, () => GoogleCalendarIntegrationError, "needs_connection" | "unavailable", string]> = [
      ["400 invalid_grant", deadGrant, "needs_connection", "Sign-in expired"],
      ["Google 503", googleDown, "unavailable", "Status unavailable"],
      ["a network error on the refresh", networkBlip, "unavailable", "Status unavailable"],
      ["a 400 that is not invalid_grant", badRequest, "unavailable", "Status unavailable"],
    ];
    for (const [why, make, kind, label] of cases) {
      const { value, calls } = await status({ read: failWith(make()), fact: OWN_READY });
      assert.deepEqual(value.result, { ready: false, kind, label }, why);
      assert.equal(calls.length, 1, `${why}: logged`);
      assert.match(JSON.stringify(calls[0][1]), /token_refresh_failed/, why);
    }
  });

  await check("both tokens rejected (workspace_calendar_token_invalid) follows the refusal that decided it: dead grant says Sign-in expired, a blip or no reason says Status unavailable", async () => {
    const cases: Array<[string, GoogleCalendarIntegrationError, "needs_connection" | "unavailable"]> = [
      ["the workspace grant was refused", bothRejected(deadGrant()), "needs_connection"],
      ["the workspace refresh timed out", bothRejected(networkBlip()), "unavailable"],
      ["the workspace refresh got a 503", bothRejected(googleDown()), "unavailable"],
      ["no reason attached", bothRejected(), "unavailable"],
    ];
    for (const [why, error, kind] of cases) {
      const { value } = await status({ read: failWith(error), fact: OWN_READY });
      assert.equal(value.result.kind, kind, why);
      assert.equal(value.result.label, kind === "needs_connection" ? "Sign-in expired" : "Status unavailable", why);
    }
  });

  await check("a failure that is not a Google error (a database fault, say) is Status unavailable, not Not connected, and logged", async () => {
    const { value, calls } = await status({ read: failWith(new Error("database is locked")) });
    assert.deepEqual(value.result, { ready: false, kind: "unavailable", label: "Status unavailable" });
    assert.equal(calls.length, 1);
    assert.match(JSON.stringify(calls[0][1]), /database is locked/);
  });

  // -- 3. The read is the one availability makes ------------------------------
  await check("the read is made for the host's own id and address, for the next 15 minutes", async () => {
    const { value } = await status({ fact: OWN_READY }, ADON);
    assert.deepEqual(value.reads, [
      {
        tenantId: TENANT,
        organizerUserId: ADON.userId,
        expectedOrganizerEmail: ADON.email,
        timeMin: new Date(NOW).toISOString(),
        timeMax: new Date(NOW + 15 * 60_000).toISOString(),
      },
    ]);
  });

  const roster = [
    { auth_user_id: CC.userId, email: CC.email, full_name: "CC", display_name: null },
    { auth_user_id: ADON.userId, email: ADON.email, full_name: "Adon", display_name: null },
  ] as never;
  const ownerSettings = defaultOasisBookingSettings({ organizerUserId: CC.userId, attendeeUserId: null });
  // This suite also exercises the generic two-host status machinery. Build that
  // fixture explicitly; OASIS's production default remains proprietor-only.
  const settings = {
    ...ownerSettings,
    hosts: [
      ownerSettings.hosts[0],
      { ...ownerSettings.hosts[0], userId: ADON.userId, role: "attendee" as const },
    ],
  };
  const { hostIdentities } = await import("../lib/booking/settings-store");
  const { loadPublicBookingAvailability } = await import("../lib/forms/public-booking");

  await check("the card's reads match, host for host, the reads /book's availability makes (same arguments)", async () => {
    const availability: ReadArgs[] = [];
    await loadPublicBookingAvailability(
      { tenantId: TENANT, durationMinutes: 15, now: NOW },
      {
        loadSettings: async () => ({ settings }),
        roster: async () => roster,
        listGoogleBusy: (async (args: ReadArgs) => {
          availability.push(args);
          return [];
        }) as never,
        listScheduleEvents: async () => [],
      },
    );
    const { deps, reads } = depsWith();
    await hostCalendarStatuses({ tenantId: TENANT, hosts: settings.hosts, identities: hostIdentities(roster) }, deps);
    const identity = (a: ReadArgs) => `${a.tenantId}|${a.organizerUserId}|${a.expectedOrganizerEmail}`;
    assert.equal(availability.length, 2, "availability reads both hosts");
    assert.deepEqual(reads.map(identity).sort(), availability.map(identity).sort());
    assert.deepEqual(Object.keys(reads[0]).sort(), Object.keys(availability[0]).sort(), "and passes the same fields");
  });

  await check("the card says a host must connect exactly when /book leaves that host off (one rule, two readers: this fails if either one's changes)", async () => {
    // The same fixtures /book's own test uses (tests/public-booking-absent-attendee.test.ts): Adon's read fails, CC's works.
    const MONDAY_NOON = "2026-10-19T16:00:00.000Z";
    const bookNow = Date.parse("2026-10-15T18:00:00.000Z");
    const cases: Array<[string, () => unknown]> = [
      ["nothing connected", () => new GoogleCalendarIntegrationError("google_calendar_not_connected", "not connected")],
      ["another Google account", () => new GoogleCalendarIntegrationError("calendar_organizer_mismatch", "wrong account")],
      ["no calendar permission", () => new GoogleCalendarIntegrationError("calendar_scope_required", "gmail only")],
      ["a revoked grant", deadGrant],
      ["a network error on the refresh", networkBlip],
      ["Google 503 on the refresh", googleDown],
      ["a 400 that is not invalid_grant", badRequest],
      ["a failed calendar read", () => new GoogleCalendarIntegrationError("calendar_availability_failed", "500", { httpStatus: 500 })],
      ["an unexpected error", () => new Error("boom")],
    ];
    for (const [why, make] of cases) {
      const { value: slots } = await logged(() =>
        loadPublicBookingAvailability(
          { tenantId: TENANT, durationMinutes: 15, now: bookNow },
          {
            loadSettings: async () => ({ settings }),
            roster: async () => roster,
            listGoogleBusy: (async (args: ReadArgs) => {
              if (args.organizerUserId === ADON.userId) throw make();
              return [];
            }) as never,
            listScheduleEvents: async () => [],
          },
        ),
      );
      const monday = slots.find((slot) => slot.start === MONDAY_NOON)?.hosts.map((host) => host.userId) ?? null;
      const bookLeavesAdonOff = monday !== null && monday.length === 1 && monday[0] === CC.userId;
      if (!bookLeavesAdonOff) assert.equal(monday, null, `${why}: /book either leaves Adon off or closes the slot`);
      const { value } = await status({ read: failWith(make()), fact: NOT_LINKED }, ADON);
      assert.equal(value.result.kind === "needs_connection", bookLeavesAdonOff, `${why}: card says "${value.result.label}", /book ${bookLeavesAdonOff ? "leaves Adon off" : "closes the slot"}`);
    }
  });

  await check("every configured host is read, in order, with their OWN email: CC through the workspace, Adon truly Not connected", async () => {
    const { deps, reads } = depsWith({
      read: async (args) => {
        if (args.organizerUserId === ADON.userId) throw new GoogleCalendarIntegrationError("google_calendar_not_connected", "no sign-in");
        return [];
      },
      fact: NOT_LINKED,
    });
    const { value } = await logged(() => hostCalendarStatuses({ tenantId: TENANT, hosts: settings.hosts, identities: hostIdentities(roster) }, deps));
    assert.deepEqual(
      settings.hosts.map((h) => h.userId),
      [CC.userId, ADON.userId],
      "precondition: the organizer is first",
    );
    assert.deepEqual(value, [
      { ready: true, kind: "workspace", label: WORKSPACE },
      { ready: false, kind: "needs_connection", label: "Not connected" },
    ]);
    assert.deepEqual(
      reads.map((r) => [r.organizerUserId, r.expectedOrganizerEmail]),
      [
        [CC.userId, CC.email],
        [ADON.userId, ADON.email],
      ],
    );
  });

  await check("a host missing from the roster is not read with a guessed address: unavailable, logged", async () => {
    const { deps, reads } = depsWith();
    const onlyCc = new Map([...hostIdentities(roster)].filter(([id]) => id === CC.userId));
    const { value, calls } = await logged(() => hostCalendarStatuses({ tenantId: TENANT, hosts: settings.hosts, identities: onlyCc }, deps));
    assert.deepEqual(value[1], { ready: false, kind: "unavailable", label: "Status unavailable" });
    assert.deepEqual(reads.map((r) => r.organizerUserId), [CC.userId], "no read for the host nobody can name");
    assert.match(JSON.stringify(calls), /booking_host_not_on_roster/);
  });

  // -- 4. Kept answers and the deadline: the card's GET spends Google calls ---------
  const both = { tenantId: TENANT, hosts: settings.hosts, identities: hostIdentities(roster) };

  await check("a host's answer is kept for 30 seconds: a second load inside that reads nothing, one after it reads again", async () => {
    const { deps, reads, clock } = depsWith();
    const first = await hostCalendarStatuses(both, deps);
    assert.equal(reads.length, 2, "one read per host");
    clock.at += HOST_STATUS_TTL_MS - 1;
    assert.deepEqual(await hostCalendarStatuses(both, deps), first);
    assert.equal(reads.length, 2, "inside the 30 seconds: nothing read");
    clock.at += 1;
    await hostCalendarStatuses(both, deps);
    assert.equal(reads.length, 4, "at 30 seconds: both hosts are read again");
    assert.equal(HOST_STATUS_TTL_MS, 30_000);
  });

  await check("a failing Google is not hammered either: failures are kept as long as successes", async () => {
    const { deps, reads } = depsWith({
      read: async (args) => {
        throw args.organizerUserId === CC.userId ? googleDown() : new GoogleCalendarIntegrationError("calendar_scope_required", "gmail only");
      },
    });
    const first = (await logged(() => hostCalendarStatuses(both, deps))).value;
    assert.deepEqual(first.map((s) => s.kind), ["unavailable", "needs_connection"]);
    const again = (await logged(() => hostCalendarStatuses(both, deps))).value;
    assert.deepEqual(again, first);
    assert.equal(reads.length, 2, "the second load read nothing");
  });

  await check("each host is kept on its own, and a changed address is a new host", async () => {
    const { deps, reads } = depsWith();
    await hostCalendarStatuses({ ...both, hosts: [settings.hosts[0]] }, deps);
    assert.deepEqual(reads.map((r) => r.organizerUserId), [CC.userId]);
    await hostCalendarStatuses(both, deps);
    assert.deepEqual(reads.map((r) => r.organizerUserId), [CC.userId, ADON.userId], "CC was kept; only Adon was read");
    const moved = new Map(hostIdentities(roster));
    moved.set(CC.userId, { userId: CC.userId, email: "cc.new@oasisai.work", displayName: "CC" });
    await hostCalendarStatuses({ ...both, identities: moved }, deps);
    assert.equal(reads.length, 3);
    assert.equal(reads[2].expectedOrganizerEmail, "cc.new@oasisai.work", "CC under a new address is read again");
  });

  await check("simultaneous first loads each make their own read: nothing pending is ever shared between requests (a Worker request must not wait on another's I/O)", async () => {
    const { deps, reads } = depsWith();
    await Promise.all([hostCalendarStatuses(both, deps), hostCalendarStatuses(both, deps), hostCalendarStatuses(both, deps)]);
    assert.equal(reads.length, 6, "three loads, two hosts, no sharing: the cache holds settled answers only");
    for (const entry of deps.cache.values()) assert.ok(!(entry.status instanceof Promise) && typeof entry.at === "number");
  });

  await check("a read that takes longer than the deadline is Status unavailable, logged, kept, and its late answer changes nothing", async () => {
    let release!: () => void;
    const hang = new Promise<unknown[]>((resolve) => {
      release = () => resolve([]);
    });
    const { deps, reads } = depsWith({ read: () => hang, deadlineMs: 25 });
    // Without a deadline this would wait on Google forever: fail in two seconds instead of hanging the run.
    let guard: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error("the card was still waiting on Google after 2 s: the deadline never fired")), 2_000);
    });
    const { value, calls } = await logged(() =>
      Promise.race([hostCalendarStatuses({ ...both, hosts: [settings.hosts[0]] }, deps), gaveUp]).finally(() => clearTimeout(guard)),
    );
    assert.deepEqual(value, [{ ready: false, kind: "unavailable", label: "Status unavailable" }]);
    assert.equal(calls.length, 1);
    assert.match(JSON.stringify(calls[0][1]), /no answer within 25 ms/);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual((await hostCalendarStatuses({ ...both, hosts: [settings.hosts[0]] }, deps))[0].kind, "unavailable", "kept: the late answer did not rewrite it");
    assert.equal(reads.length, 1, "and nothing was read again inside the 30 seconds");
  });

  // -- 5. The card -------------------------------------------------------------
  // (The route itself runs, against real libSQL, in tests/booking-card-route.test.ts.)
  const cardSrc = readFileSync(join(ROOT, "components/calendar/BookingLinkCard.tsx"), "utf8");

  await check("the card acts on the status's kind, never on its words", () => {
    assert.doesNotMatch(cardSrc, /calendar\.label\s*(?:===|!==|\.includes|\.startsWith|\.match|\.test)/, "no branch reads the label text");
    assert.match(cardSrc, /calendar\.kind === "workspace"/);
    assert.match(cardSrc, /calendar\.kind === "unavailable"/);
  });

  // The card as the page runs it, answering with the hosts' statuses.
  type CalendarState = { ready: boolean; kind: "connected" | "workspace" | "needs_connection" | "unavailable"; label: string };
  const cardInfo = (hosts: Array<{ userId: string; name: string; role: "organizer" | "attendee"; calendar: CalendarState }>, you: string) => ({
    ok: true,
    available: true,
    path: "/book",
    live: true,
    version: 1,
    saved: true,
    settings: settings,
    canEdit: true,
    you,
    hosts,
    calendars: [{ id: "main", name: "Main calendar", isDefault: true }],
  });
  async function openCard(info: unknown) {
    (globalThis as unknown as { window: unknown }).window = { location: { origin: "https://occ.test" } };
    globalThis.fetch = (async () => new Response(JSON.stringify(info), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { BookingLinkCard } = await import("../components/calendar/BookingLinkCard");
    slots = [];
    effects = [];
    const render = () => {
      cursor = 0;
      return BookingLinkCard();
    };
    render();
    for (const run of effects.splice(0)) run();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    const tree = render();
    assert.ok(tree, "the card drew");
    return {
      tree,
      render,
      host: (name: RegExp) => {
        const li = elements(tree).find((e) => e.type === "li" && name.test(flat(e.props.children)));
        assert.ok(li, `a line for ${name}`);
        return { text: flat(li.props.children), notes: elements(li.props.children).filter((e) => e.type === "span" && /Google Calendar:/.test(flat(e.props.children))) };
      },
    };
  }
  const hostsOf = (cc: CalendarState, adon: CalendarState) => [
    { userId: CC.userId, name: "CC", role: "organizer" as const, calendar: cc },
    { userId: ADON.userId, name: "Adon", role: "attendee" as const, calendar: adon },
  ];

  await check("the card: CC through the workspace gets a quiet line, Adon's true Not connected keeps its warning", async () => {
    const card = await openCard(
      cardInfo(hostsOf({ ready: true, kind: "workspace", label: WORKSPACE }, { ready: false, kind: "needs_connection", label: "Not connected" }), CC.userId),
    );
    const cc = card.host(/^You/);
    assert.equal(cc.notes.length, 1, "one note for CC");
    assert.equal(flat(cc.notes[0].props.children), `Google Calendar: ${WORKSPACE}.`);
    assert.match(String(cc.notes[0].props.className), /text-fg-dim/, "quiet");
    assert.doesNotMatch(String(cc.notes[0].props.className), /status-warm/, "not a warning");
    assert.doesNotMatch(cc.text, /No times can be offered|Connect it/, "CC is not told to connect anything");

    const adon = card.host(/^Adon/);
    assert.equal(adon.notes.length, 1);
    assert.match(String(adon.notes[0].props.className), /text-status-warm/, "Adon's gap is still a warning");
    assert.match(adon.text, /Google Calendar: Not connected\. Times that need them are closed until it is connected\. They connect it in Settings, Connections\./);
  });

  await check("the card: a host who must reconnect keeps the warning wording, with Connect it for you; a host on their own sign-in shows nothing extra", async () => {
    const down = await openCard(
      cardInfo(hostsOf({ ready: false, kind: "needs_connection", label: "Sign-in expired" }, { ready: true, kind: "connected", label: "Connected" }), CC.userId),
    );
    const cc = down.host(/^You/);
    assert.match(cc.text, /Google Calendar: Sign-in expired\. No times can be offered until it is connected\. Connect it/);
    assert.match(String(cc.notes[0].props.className), /text-status-warm/);
    assert.equal(down.host(/^Adon/).notes.length, 0, "a host on their own connection has no extra line");
  });

  await check("the card: a host it could not check is told as such, with no 'connect it' and no 'until it is connected'", async () => {
    const card = await openCard(
      cardInfo(hostsOf({ ready: false, kind: "unavailable", label: "Status unavailable" }, { ready: false, kind: "unavailable", label: "Status unavailable" }), CC.userId),
    );
    const cc = card.host(/^You/);
    assert.match(cc.text, /Google Calendar: Status unavailable\. It could not be checked just now, which does not mean it is disconnected\. Times may not be offered until it can be read\./);
    const adon = card.host(/^Adon/);
    assert.match(adon.text, /Google Calendar: Status unavailable\. It could not be checked just now, which does not mean it is disconnected\. Times that need them may be closed until it can be read\./);
    for (const line of [cc, adon]) {
      assert.doesNotMatch(line.text, /Connect it|until it is connected|They connect it/, "an unreadable calendar is not a call to connect");
      assert.match(String(line.notes[0].props.className), /text-status-warm/, "still not ready, so still marked");
    }
  });

  // -- 6. The card fits (structure here; the pixels were measured in Chromium) -----
  await check("the card wraps in the 248px sidebar: buttons wrap, nothing truncates, every line may break", async () => {
    assert.doesNotMatch(cardSrc, /\btruncate\b/, "no line is cut off with an ellipsis");
    assert.match(cardSrc, /<div className="mt-2 flex flex-wrap gap-1\.5">/, "Copy, Open and Settings wrap instead of overflowing");
    assert.match(cardSrc, /<section aria-labelledby="cal-booking-h" className="break-words /, "long words break inside the card");
    assert.match(cardSrc, /<p className="mt-2 break-all font-mono/, "the URL breaks instead of running off");
    const card = await openCard(cardInfo([{ userId: CC.userId, name: "CC", role: "organizer", calendar: { ready: true, kind: "connected", label: "Connected" } }], CC.userId));
    const row = elements(card.tree).find((e) => e.type === "div" && /\bflex-wrap\b/.test(String(e.props.className)));
    assert.ok(row, "the button row");
    const buttons = (Array.isArray(row.props.children) ? (row.props.children as unknown[]) : [row.props.children]).filter(isValidElement) as unknown as El[];
    assert.deepEqual(buttons.map((b) => flat(b.props.children)), ["Copy", "Open", "Settings"], "all three words are there, whole");
    for (const b of buttons) {
      const first = (b.props.children as unknown[])[0];
      assert.ok(isValidElement(first) && (first as unknown as El).props["aria-hidden"], `${flat(b.props.children)} keeps its icon`);
    }
  });

  await check("the settings dialog fits a 360px phone: days stack, the three options stack, and from sm up it is as before", () => {
    assert.doesNotMatch(cardSrc, /grid-cols-\[6\.5rem_1fr_auto_1fr\]/, "the fixed four-column day row is gone");
    assert.match(cardSrc, /grid grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\][^"]*sm:grid-cols-\[6\.5rem_minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
    assert.match(cardSrc, /<label className="col-span-3 [^"]*sm:col-span-1">/, "the day sits above its times on a phone");
    assert.match(cardSrc, /<div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">/, "Notice, Book ahead and Gap: one column on a phone, three from sm");
    assert.doesNotMatch(cardSrc, /"[^"]*(?<!sm:)\bgrid-cols-3\b/, "no bare three-column grid is left");
    assert.match(cardSrc, /<fieldset key=\{host\.userId\} className="mt-5 min-w-0">/, "a fieldset may shrink below its widest row");
  });

  // CC asked for nothing cut off at 320px. Measured in Chromium at a 320px viewport (the dialog is 288px, each
  // time field 113px with 12px side padding): "10:00 AM" is 64.7px of text, the field showed 58.3px of it, so the
  // last letter was cut on all 28 fields ("10:00 AI"). With the clock icon gone the field shows 87px. This CI has
  // no browser, so the rule that does it is pinned where it lives, in the real CSS: a plain `px-2` on the field
  // would pass a class-string check and change nothing, because `.input` (globals.css) comes after Tailwind's
  // utilities and wins. Remove the rule, the class, or move the breakpoint to 360px and this fails.
  await check("below 360px the time fields give up their clock icon so AM and PM are not cut off: the narrow rule is in the real CSS and every rendered time field carries its class", async () => {
    const css = parse(readFileSync(join(ROOT, "components/calendar/calendar.css"), "utf8"));
    const found: Array<{ maxWidth: number; display: string | undefined }> = [];
    css.walkAtRules("media", (media) => {
      const width = /^\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(media.params.trim());
      if (!width) return;
      media.walkRules((rule) => {
        if (!rule.selectors.includes(".cal .input.time-field::-webkit-calendar-picker-indicator")) return;
        let display: string | undefined;
        rule.walkDecls("display", (decl) => void (display = decl.value));
        found.push({ maxWidth: Number(width[1]), display });
      });
    });
    assert.equal(found.length, 1, "exactly one max-width rule hides the clock icon of .time-field");
    assert.equal(found[0].display, "none", "it hides the icon");
    assert.ok(found[0].maxWidth >= 359 && found[0].maxWidth < 360, `it applies below 360px and not at it (max-width ${found[0].maxWidth}px)`);

    // The rule only reaches fields that carry the class: open the real dialog and look at every time field it draws.
    const card = await openCard(cardInfo(hostsOf({ ready: true, kind: "workspace", label: WORKSPACE }, { ready: false, kind: "needs_connection", label: "Not connected" }), CC.userId));
    const settingsButton = elements(card.tree).find((e) => e.type === "button" && /Settings/.test(flat(e.props.children)));
    assert.ok(settingsButton, "the Settings button");
    (settingsButton.props.onClick as () => void)();
    const dialog = elements(card.render()).find((e) => typeof e.type === "function");
    assert.ok(dialog, "the settings dialog is open");
    const fields = elements((dialog.type as (props: unknown) => unknown)(dialog.props)).filter((e) => e.type === "input" && e.props.type === "time");
    assert.equal(fields.length, 28, "two hosts, seven days, a start and an end each");
    for (const field of fields) {
      const classes = String(field.props.className).split(/\s+/);
      assert.ok(classes.includes("input") && classes.includes("time-field"), `${String(field.props["aria-label"])} is .input.time-field (it is: ${classes.join(" ")})`);
    }
  });

  console.log("booking-host-calendar-status: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
