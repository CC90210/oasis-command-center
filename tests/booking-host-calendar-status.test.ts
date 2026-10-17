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
 *      back to the person's own connection;
 *   3. the read is made for each host's own address with the arguments
 *      availability passes (lib/forms/public-booking.ts);
 *   4. the card warns for a host who is not ready (Adon's true "Not connected"
 *      stays) and shows the workspace route as a quiet line, not a warning;
 *   5. the card fits the 248px sidebar and the settings dialog fits a phone.
 *
 * The read is injected: nothing here reaches Google or the database.
 * Run: node --conditions=react-server --import tsx tests/booking-host-calendar-status.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Deps that record every call. `read` answers (or throws) the calendar read; `fact` the person's own connection. */
function depsWith(opts: { read?: (args: ReadArgs) => Promise<unknown[]>; fact?: PersonalGoogleFact | (() => never); workspace?: string | null } = {}) {
  const reads: ReadArgs[] = [];
  const factReads: Array<[string, string]> = [];
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
    now: () => NOW,
  };
  return { deps, reads, factReads };
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
  const { hostCalendarStatus, hostCalendarStatuses, WORKSPACE_CALENDAR_LABEL } = (await import("../lib/booking/host-calendar-status")) as Mod;

  const WORKSPACE = `${WORKSPACE_CALENDAR_LABEL} (${CC.email})`;
  const status = (over: Parameters<typeof depsWith>[0], host = CC) =>
    logged(async () => {
      const made = depsWith(over);
      return { ...made, result: await hostCalendarStatus({ tenantId: TENANT, ...host }, made.deps) };
    });

  // -- 1. A read that works ------------------------------------------------
  await check("own connection ready and the read works: ready, and the person's own label is kept", async () => {
    const { value, calls } = await status({ fact: OWN_READY });
    assert.deepEqual(value.result, { ready: true, label: "Connected" });
    assert.deepEqual(calls, [], "nothing to log");
  });

  await check("no own connection but the read works (CC's case, the workspace credential is his account): ready, through the workspace, never a bare Connected", async () => {
    for (const [why, fact] of [
      ["nothing linked", NOT_LINKED],
      ["linked to another Google account", WRONG_ACCOUNT],
      ["linked without calendar permission", NO_CALENDAR],
    ] as const) {
      const { value, calls } = await status({ fact });
      assert.deepEqual(value.result, { ready: true, label: WORKSPACE }, why);
      assert.notEqual(value.result.label, "Connected", `${why}: never just Connected`);
      assert.deepEqual(calls, [], `${why}: a working read is not a fault`);
    }
    assert.equal(WORKSPACE, "Connected through the workspace calendar (conaugh@oasisai.work)");
  });

  await check("with no workspace address on hand the label still names the route and never prints null", async () => {
    const { value } = await status({ fact: NOT_LINKED, workspace: null });
    assert.deepEqual(value.result, { ready: true, label: WORKSPACE_CALENDAR_LABEL });
  });

  await check("the person's own connection cannot be read while the calendar reads: ready, no claim about whose sign-in, and logged", async () => {
    const { value, calls } = await status({
      fact: () => {
        throw new Error("profile read failed");
      },
    });
    assert.deepEqual(value.result, { ready: true, label: "Calendar readable" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "[calendar.booking.host-status]");
    assert.match(JSON.stringify(calls[0][1]), /profile read failed/);
  });

  // -- 2. A read that fails ------------------------------------------------
  const failures: Array<[GoogleCalendarErrorCode, string]> = [
    ["google_calendar_not_connected", "Not connected"],
    ["calendar_scope_required", "Needs calendar permission"],
    ["calendar_organizer_mismatch", "Connected to a different Google account"],
    ["token_refresh_failed", "Sign-in expired"],
    ["workspace_calendar_token_invalid", "Sign-in expired"],
    ["calendar_availability_failed", "Status unavailable"],
    ["google_oauth_config_missing", "Status unavailable"],
  ];
  for (const [code, label] of failures) {
    await check(`a read that fails with ${code} says "${label}", is not ready, and never trusts the person's own connection`, async () => {
      // The person's own connection reads as ready: a failed read must still win.
      const { value, calls } = await status({ read: fail(code), fact: OWN_READY });
      assert.deepEqual(value.result, { ready: false, label });
      assert.deepEqual(value.factReads, [], "the own-connection fact is not consulted when the read failed");
      if (code === "google_calendar_not_connected") assert.deepEqual(calls, [], "a host who has not connected is said, not logged");
      else {
        assert.equal(calls.length, 1, "any other failure is logged");
        assert.equal(calls[0][0], "[calendar.booking.host-status]");
        assert.match(JSON.stringify(calls[0][1]), new RegExp(code));
      }
    });
  }

  await check("a failure that is not a Google error (a database fault, say) is Status unavailable, not Not connected, and logged", async () => {
    const { value, calls } = await status({
      read: async () => {
        throw new Error("database is locked");
      },
    });
    assert.deepEqual(value.result, { ready: false, label: "Status unavailable" });
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
  const settings = defaultOasisBookingSettings({ organizerUserId: CC.userId, attendeeUserId: ADON.userId });
  const { hostIdentities } = await import("../lib/booking/settings-store");

  await check("the card's reads match, host for host, the reads /book's availability makes (same arguments)", async () => {
    const { loadPublicBookingAvailability } = await import("../lib/forms/public-booking");
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
      { ready: true, label: WORKSPACE },
      { ready: false, label: "Not connected" },
    ]);
    assert.deepEqual(
      reads.map((r) => [r.organizerUserId, r.expectedOrganizerEmail]),
      [
        [CC.userId, CC.email],
        [ADON.userId, ADON.email],
      ],
    );
  });

  await check("a host missing from the roster is not read with a guessed address: not ready, logged", async () => {
    const { deps, reads } = depsWith();
    const onlyCc = new Map([...hostIdentities(roster)].filter(([id]) => id === CC.userId));
    const { value, calls } = await logged(() => hostCalendarStatuses({ tenantId: TENANT, hosts: settings.hosts, identities: onlyCc }, deps));
    assert.deepEqual(value[1], { ready: false, label: "Status unavailable" });
    assert.deepEqual(reads.map((r) => r.organizerUserId), [CC.userId], "no read for the host nobody can name");
    assert.match(JSON.stringify(calls), /booking_host_not_on_roster/);
  });

  // -- 4. The route and the card -----------------------------------------------
  const routeSrc = readFileSync(join(ROOT, "app/api/calendar/booking/route.ts"), "utf8");
  const cardSrc = readFileSync(join(ROOT, "components/calendar/BookingLinkCard.tsx"), "utf8");

  await check("the route takes each host's status from the shared read, with the roster's identities, and no longer from the own-connection fact", () => {
    assert.match(routeSrc, /import \{ hostCalendarStatuses \} from "@\/lib\/booking\/host-calendar-status";/);
    assert.match(routeSrc, /const identities = hostIdentities\(roster\);/);
    assert.match(
      routeSrc,
      /await hostCalendarStatuses\(\{\s*tenantId: owner\.tenantId,\s*hosts: loaded\.settings\.hosts,\s*identities,\s*\}\)/,
    );
    assert.match(routeSrc, /calendar: statuses\[index\]/);
    assert.doesNotMatch(routeSrc, /readPersonalGoogleFact|personalGoogleStatus/, "the card no longer answers from the own-connection fact");
  });

  await check("the card matches the phrase the status writes", () => {
    const phrase = /includes\("([^"]+)"\)/.exec(cardSrc)?.[1];
    assert.ok(phrase, "the card names the phrase it looks for");
    assert.ok(WORKSPACE_CALENDAR_LABEL.includes(phrase), `"${WORKSPACE_CALENDAR_LABEL}" contains "${phrase}"`);
  });

  // The card as the page runs it, answering with the hosts' statuses.
  const cardInfo = (hosts: Array<{ userId: string; name: string; role: "organizer" | "attendee"; calendar: { ready: boolean; label: string } }>, you: string) => ({
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
      host: (name: RegExp) => {
        const li = elements(tree).find((e) => e.type === "li" && name.test(flat(e.props.children)));
        assert.ok(li, `a line for ${name}`);
        return { text: flat(li.props.children), notes: elements(li.props.children).filter((e) => e.type === "span" && /Google Calendar:/.test(flat(e.props.children))) };
      },
    };
  }

  await check("the card: CC through the workspace gets a quiet line, Adon's true Not connected keeps its warning", async () => {
    const card = await openCard(
      cardInfo(
        [
          { userId: CC.userId, name: "CC", role: "organizer", calendar: { ready: true, label: WORKSPACE } },
          { userId: ADON.userId, name: "Adon", role: "attendee", calendar: { ready: false, label: "Not connected" } },
        ],
        CC.userId,
      ),
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

  await check("the card: an organizer who cannot be read keeps the old warning wording, with Connect it for you; a host on their own sign-in shows nothing extra", async () => {
    const down = await openCard(
      cardInfo(
        [
          { userId: CC.userId, name: "CC", role: "organizer", calendar: { ready: false, label: "Sign-in expired" } },
          { userId: ADON.userId, name: "Adon", role: "attendee", calendar: { ready: true, label: "Connected" } },
        ],
        CC.userId,
      ),
    );
    const cc = down.host(/^You/);
    assert.match(cc.text, /Google Calendar: Sign-in expired\. No times can be offered until it is connected\. Connect it/);
    assert.match(String(cc.notes[0].props.className), /text-status-warm/);
    assert.equal(down.host(/^Adon/).notes.length, 0, "a host on their own connection has no extra line");
  });

  // -- 5. The card fits (structure; the pixels are checked in a browser) -------
  await check("the card wraps in the 248px sidebar: buttons wrap, nothing truncates, every line may break", async () => {
    assert.doesNotMatch(cardSrc, /\btruncate\b/, "no line is cut off with an ellipsis");
    assert.match(cardSrc, /<div className="mt-2 flex flex-wrap gap-1\.5">/, "Copy, Open and Settings wrap instead of overflowing");
    assert.match(cardSrc, /<section aria-labelledby="cal-booking-h" className="break-words /, "long words break inside the card");
    assert.match(cardSrc, /<p className="mt-2 break-all font-mono/, "the URL breaks instead of running off");
    const card = await openCard(cardInfo([{ userId: CC.userId, name: "CC", role: "organizer", calendar: { ready: true, label: "Connected" } }], CC.userId));
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

  console.log("booking-host-calendar-status: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
