/**
 * The routine restore card, as the page runs it.
 *
 * WHY THIS EXISTS. Defects the audit of PR #493 found in the client:
 *
 *   1. The card's restore wrapped everything, including onRestored (which runs
 *      after the server already answered 201), in a bare `catch {}` that
 *      logged nothing and always said "Could not reach the server". A network
 *      failure is now logged, and a failure after a successful write says the
 *      routine was saved.
 *   2. A restore whose reply is lost can still have saved its rows, so a failed
 *      restore is read back, and the card goes once the rows are there.
 *
 * The old "browser-week import" (the week the old Schedule page saved in this
 * browser, offered as "Bring it into the calendar") was removed on 2026-10-17
 * at CC's request: "It doesn't even work." Its checks went with it. Section 4
 * pins that the page no longer reads that storage and no longer offers it.
 *
 * Section 5 pins that "Edit times" fits a 320px phone: the time fields' sizing
 * rule in calendar.css, and a row that stacks and wraps instead of cutting a
 * block's name or scrolling the card sideways.
 *
 * The card is a client component; it runs here with a minimal stand-in for
 * React's hooks (no DOM), so its real click handlers are exercised. The page
 * (CalendarApp) runs one level deep: its own hooks and effects, against a
 * stand-in window and server; its children stay elements, never called.
 *
 * Run: node --conditions=react-server --import tsx tests/calendar-routine-card.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "postcss";
import * as ReactNS from "react";
import { Children, isValidElement, type ReactNode } from "react";

// The page runs in the viewer's browser, in the viewer's zone.
process.env.TZ = "America/Toronto";
const ROOT = join(__dirname, "..");

// ── A minimal hook runtime: state survives re-renders; effects run only when a check flushes them ────
// The module object the components' `import { useState } from "react"` reads at call time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require("react") as Record<string, unknown>;
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
let slots: unknown[] = [];
let cursor = 0;
let effects = new Map<number, () => void>();
class Callback {
  constructor(readonly deps: unknown[] | undefined, readonly fn: unknown) {}
}
class Effect {
  constructor(readonly deps: unknown[] | undefined, public cleanup: unknown) {}
}
const sameDeps = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
R.useState = (init: unknown) => {
  const i = cursor++;
  // A setter keeps writing to its own mount, even when it fires after the next check mounted.
  const own = slots;
  if (!(i in own)) own[i] = typeof init === "function" ? (init as () => unknown)() : init;
  return [own[i], (v: unknown) => (own[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(own[i]) : v)];
};
R.useMemo = (fn: () => unknown) => fn();
R.useCallback = (fn: unknown, deps?: unknown[]) => {
  const i = cursor++;
  const prev = slots[i];
  if (prev instanceof Callback && sameDeps(prev.deps, deps)) return prev.fn;
  slots[i] = new Callback(deps, fn);
  return fn;
};
R.useRef = (current: unknown) => {
  const i = cursor++;
  if (!(i in slots)) slots[i] = { current };
  return slots[i];
};
R.useEffect = (fn: () => unknown, deps?: unknown[]) => {
  const i = cursor++;
  const own = slots;
  const prev = own[i];
  if (prev instanceof Effect && sameDeps(prev.deps, deps)) return;
  own[i] = new Effect(deps, prev instanceof Effect ? prev.cleanup : undefined);
  effects.set(i, () => {
    const fx = own[i] as Effect;
    if (typeof fx.cleanup === "function") fx.cleanup();
    fx.cleanup = fn();
  });
};
function mount(render: () => unknown) {
  slots = [];
  effects = new Map();
  return () => {
    cursor = 0;
    return render();
  };
}
/** Runs the effects the last render scheduled, in hook order. */
function flushEffects() {
  const due = [...effects.entries()].sort((a, b) => a[0] - b[0]);
  effects = new Map();
  for (const [, run] of due) run();
}
/** Runs every effect cleanup of the current mount (timers, listeners). */
function unmount() {
  effects = new Map();
  for (const fx of slots) if (fx instanceof Effect && typeof fx.cleanup === "function") fx.cleanup();
}

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    if (typeof el.type === "function") return elements((el.type as (p: unknown) => unknown)(el.props), out);
    out.push(el);
    elements(el.props.children as ReactNode, out);
  }
  return out;
}
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const el = node as unknown as El;
    if (typeof el.type === "function") return textOf((el.type as (p: unknown) => unknown)(el.props));
    return textOf(el.props.children as ReactNode);
  }
  return "";
}
const flat = (tree: unknown) => textOf(tree).replace(/\s+/g, " ");
function button(tree: unknown, label: RegExp): El {
  const found = elements(tree).filter((e) => e.type === "button" && label.test(textOf(e.props.children).trim()));
  assert.equal(found.length, 1, `one button ${label} in: ${flat(tree)}`);
  return found[0];
}
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}
function captureErrors() {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void calls.push(args);
  return { calls, restore: () => (console.error = orig) };
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

async function main() {
  const routine = await import("../lib/calendar/routine");
  const { createPlaceholderSchedule } = await import("../lib/schedule/model");
  const { DEFAULT_PREFS } = await import("../lib/calendar/types");
  const { RoutineRestore, sendRoutineRestore } = await import("../components/calendar/RoutineRestore");
  type EventRecord = import("../lib/calendar/types").EventRecord;
  type EventInput = import("../lib/calendar/types").EventInput;

  const FROM = new Date("2026-09-30T12:00:00-04:00");
  const record = (e: EventInput, id: string): EventRecord => ({ ...e, id, createdAt: "", updatedAt: "" });
  // The routine as a restore wrote it.
  const restoredPlan = routine.buildRoutineSeries(routine.routineBlocks(), { calendarId: "cal", prefs: DEFAULT_PREFS, from: FROM });
  const restored = [...restoredPlan.series, ...restoredPlan.singles].map(({ event }, i) => record(event, `${routine.ROUTINE_ID_PREFIX}${i}`));

  // -- 1. The page's wiring -----------------------------------------------------
  await check("CalendarApp: the restore card shows only on an EMPTY calendar; a client's first paint has no city and no lock", () => {
    const src = readFileSync(join(ROOT, "components/calendar/CalendarApp.tsx"), "utf8");
    // Restoring on top of events already there would put every block in twice.
    assert.match(src, /const emptyCalendar = data\.load\.status === "ready" && events\.length === 0;/);
    assert.match(src, /\{emptyCalendar && routine && routineState === "checked" && \(\s*<RoutineRestore/);
    assert.match(src, /if \(emptyCalendar && !routineAsked\.current\) void checkRoutine\(\);/, "the server is asked only for an empty calendar");
    const data = readFileSync(join(ROOT, "components/calendar/useCalendarData.ts"), "utf8");
    assert.match(data, /useState<CalendarPrefs>\(NEUTRAL_PREFS\)/, "until the server answers: no place, no Shabbat lock");
  });

  // -- 2. The restore request -------------------------------------------------
  const answer = (status: number, body: unknown) =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

  await check("sendRoutineRestore: a request that never reached the server is logged and said as such", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const errors = captureErrors();
    try {
      const out = await sendRoutineRestore([]);
      assert.deepEqual(out, { ok: false, message: "Could not reach the server. Check your connection and try again." });
    } finally {
      errors.restore();
    }
    assert.equal(errors.calls[0]?.[0], "[calendar.routine.restore]");
    assert.match(String(errors.calls[0]?.[1]), /Failed to fetch/);
  });

  await check("sendRoutineRestore: the server's own answer is said as that answer, never as a network failure", async () => {
    globalThis.fetch = answer(403, { ok: false, error: "routine_not_available" });
    assert.deepEqual(await sendRoutineRestore([]), { ok: false, message: "The weekly routine can only be restored in the OASIS workspace." });
    globalThis.fetch = answer(201, "<html>not json</html>");
    const errors = captureErrors();
    let out;
    try {
      out = await sendRoutineRestore([]);
    } finally {
      errors.restore();
    }
    assert.equal(out.ok, false);
    assert.match((out as { message: string }).message, /reply could not be read\. Reload the page to see whether your routine was restored/);
    assert.equal(errors.calls.length, 1, "the unreadable reply is logged");
    globalThis.fetch = answer(201, { ok: true, status: "restored", created: [], adjusted: [], dropped: [] });
    assert.deepEqual(await sendRoutineRestore([]), { ok: true, body: { ok: true, status: "restored", created: [], adjusted: [], dropped: [] } });
  });

  // -- 3. The card, clicked through --------------------------------------------
  const info = { available: true as const, restored: false, timeZone: "America/Toronto", windDownMinutes: 18, blocks: routine.routineBlocks() };
  const card = (onRestored: (r: unknown) => void) =>
    mount(() => RoutineRestore({ info, prefs: DEFAULT_PREFS, calendarName: "Personal", now: FROM, onRestored, onDismiss: () => undefined }));

  await check("RoutineRestore: a failure after the server saved the routine says it was saved, is logged, and is never 'could not reach the server'", async () => {
    globalThis.fetch = answer(201, { ok: true, status: "restored", created: [], adjusted: [], dropped: [] });
    const seen: unknown[] = [];
    const view = card((r) => {
      seen.push(r);
      throw new Error("the page failed to refresh");
    });
    (button(view(), /^Restore$/).props.onClick as () => void)();
    const errors = captureErrors();
    try {
      (button(view(), /^Add them$/).props.onClick as () => void)();
      await settle();
    } finally {
      errors.restore();
    }
    const text = flat(view());
    assert.equal(seen.length, 1, "onRestored ran with the server's answer");
    assert.match(text, /Your routine was restored, but this page could not show it\. Reload the page to see it\./);
    assert.doesNotMatch(text, /Could not reach the server/);
    assert.ok(errors.calls.some((c) => c[0] === "[calendar.routine.restored]" && /failed to refresh/.test(String(c[1]))), "the page's failure is logged");
  });

  await check("RoutineRestore: a network failure keeps the card open with the reason; a success hands the answer on", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const seen: unknown[] = [];
    const view = card((r) => void seen.push(r));
    (button(view(), /^Restore$/).props.onClick as () => void)();
    const errors = captureErrors();
    try {
      (button(view(), /^Add them$/).props.onClick as () => void)();
      await settle();
    } finally {
      errors.restore();
    }
    assert.match(flat(view()), /Could not reach the server\. Check your connection and try again\./);
    assert.equal(seen.length, 0);
    assert.equal(button(view(), /^Restore$/).props.disabled, false, "the card is back to its first step");

    globalThis.fetch = answer(201, { ok: true, status: "restored", created: [], adjusted: [], dropped: [] });
    (button(view(), /^Restore$/).props.onClick as () => void)();
    (button(view(), /^Add them$/).props.onClick as () => void)();
    await settle();
    assert.deepEqual(seen, [{ ok: true, status: "restored", created: [], adjusted: [], dropped: [] }]);
    assert.doesNotMatch(flat(view()), /Could not|could not/);
  });

  await check("RoutineRestore: Edit times reaches the server; only the edited block is sent, and an unedited restore sends none", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, status: "restored", created: [], adjusted: [], dropped: [] }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const edited = card(() => undefined);
    (button(edited(), /^Edit times$/).props.onClick as () => void)();
    const wake = elements(edited()).find((e) => e.type === "input" && e.props["aria-label"] === "Wake up starts");
    assert.ok(wake, "the Wake up start time is editable");
    (wake.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "06:00" } });
    (button(edited(), /^Restore with these times$/).props.onClick as () => void)();
    (button(edited(), /^Add them$/).props.onClick as () => void)();
    await settle();
    const plain = card(() => undefined);
    (button(plain(), /^Restore$/).props.onClick as () => void)();
    (button(plain(), /^Add them$/).props.onClick as () => void)();
    await settle();
    assert.deepEqual(bodies, [{ times: [{ key: "wake-up", startMinute: 360, endMinute: 420 }] }, {}]);
  });

  await check("RoutineRestore: tells the page when a restore is sent, and when it failed", async () => {
    const told: boolean[] = [];
    const restoring = () =>
      mount(() =>
        RoutineRestore({ info, prefs: DEFAULT_PREFS, calendarName: "Personal", now: FROM, onRestoring: (p) => void told.push(p), onRestored: () => undefined, onDismiss: () => undefined }),
      );
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const failed = restoring();
    (button(failed(), /^Restore$/).props.onClick as () => void)();
    const errors = captureErrors();
    try {
      (button(failed(), /^Add them$/).props.onClick as () => void)();
      assert.deepEqual(told, [true], "told before the request goes out");
      await settle();
    } finally {
      errors.restore();
    }
    assert.deepEqual(told, [true, false]);
    told.length = 0;
    globalThis.fetch = answer(201, { ok: true, status: "restored", created: [], adjusted: [], dropped: [] });
    const saved = restoring();
    (button(saved(), /^Restore$/).props.onClick as () => void)();
    (button(saved(), /^Add them$/).props.onClick as () => void)();
    await settle();
    assert.deepEqual(told, [true], "a restore that landed is handed on through onRestored, never called failed");
  });

  // -- 4. The page, run: a restore is read back, and the old browser week is neither read nor offered --
  // A client component's stylesheet import is the bundler's business.
  (require as unknown as { extensions: Record<string, (m: { exports: unknown }) => void> }).extensions[".css"] = (m) => void (m.exports = {});
  const { CalendarApp } = await import("../components/calendar/CalendarApp");
  const { Sidebar } = await import("../components/calendar/Sidebar");
  /** The elements a component returned, its children left uncalled. */
  const shallow = (node: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) node.forEach((n) => shallow(n, out));
    else if (isValidElement(node)) {
      const el = node as unknown as El;
      out.push(el);
      shallow(el.props.children, out);
    }
    return out;
  };
  /** The text of the page's own markup (toasts included), children's left out. */
  const ownText = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(ownText).join(" ");
    if (!isValidElement(node)) return "";
    const el = node as unknown as El;
    return typeof el.type === "function" ? "" : ownText(el.props.children as ReactNode);
  };

  /**
   * CalendarApp on an empty calendar, with the routine restorable. This browser
   * still holds the week the old Schedule page saved (what the removed import
   * used to offer), and every touch of storage is recorded.
   */
  async function openPage() {
    const server = { events: [] as EventRecord[], reads: 0, unexpected: [] as string[] };
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const cal = { id: "cal", name: "Personal", color: "tide", visible: true, isDefault: true, position: 0, createdAt: "", updatedAt: "" };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(url);
      if (method === "GET" && path === "/api/calendar") {
        server.reads += 1;
        return json(200, { ok: true, calendars: [cal], events: server.events, prefs: DEFAULT_PREFS, truncated: false });
      }
      if (method === "GET" && path === "/api/calendar/routine") return json(200, { ok: true, ...info });
      server.unexpected.push(`${method} ${path}`);
      return json(500, { ok: false, error: "unexpected" });
    }) as typeof fetch;
    const stored = new Map([["oasis.schedule.week", JSON.stringify(createPlaceholderSchedule(FROM))]]);
    const storage = { read: [] as string[], written: [] as string[], scans: 0 };
    (globalThis as unknown as { window: unknown }).window = {
      innerWidth: 1280,
      localStorage: {
        get length() {
          storage.scans += 1;
          return stored.size;
        },
        key: (i: number) => {
          storage.scans += 1;
          return [...stored.keys()][i] ?? null;
        },
        getItem: (k: string) => {
          storage.read.push(k);
          return stored.get(k) ?? null;
        },
        setItem: (k: string, v: string) => {
          storage.written.push(k);
          stored.set(k, String(v));
        },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const page = mount(() => CalendarApp());
    let tree: unknown = page();
    const of = <P,>(type: unknown) => shallow(tree).find((e) => e.type === type)?.props as P | undefined;
    const p = {
      server,
      storage,
      /** Renders, runs the effects, lets the requests answer, and renders again. */
      async settle() {
        for (let k = 0; k < 4; k++) {
          flushEffects();
          await settle();
          tree = page();
        }
      },
      text: () => ownText(tree).replace(/\s+/g, " "),
      card: () => of<Parameters<typeof RoutineRestore>[0]>(RoutineRestore),
      sidebar: () => of<Parameters<typeof Sidebar>[0]>(Sidebar),
    };
    await p.settle();
    assert.ok(p.card(), `precondition: the restore card is on an empty calendar: ${p.text()}`);
    return p;
  }
  // A toast's 5-second timer must not hold the run open.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const t = realSetTimeout(fn, ms, ...rest);
    if ((ms ?? 0) >= 1000) t.unref();
    return t;
  }) as typeof setTimeout;

  await check("CalendarApp: a restore that fails is read back, and the card goes once its rows are there", async () => {
    const p = await openPage();
    try {
      const reads = p.server.reads;
      // A restore that is only sent needs no read: the card is waiting on its answer.
      p.card()!.onRestoring!(true);
      await p.settle();
      assert.equal(p.server.reads, reads, "sending a restore does not re-read the calendar");
      // The restore failed, but its rows were saved before the reply was lost: the read-back finds them.
      p.server.events = restored;
      p.card()!.onRestoring!(false);
      await p.settle();
      assert.equal(p.server.reads, reads + 1, "a failed restore is read back");
      assert.equal(p.card(), undefined, "the calendar is not empty any more, so the card is gone");
    } finally {
      unmount();
    }
  });

  await check("CalendarApp: a restore that lands is read back, the card goes, and the page says what it added", async () => {
    const p = await openPage();
    try {
      const reads = p.server.reads;
      p.server.events = restored;
      p.card()!.onRestored({ status: "restored", created: restored, adjusted: [], dropped: [] });
      await p.settle();
      assert.equal(p.server.reads, reads + 1, "the calendar is read again so the new rows show");
      assert.equal(p.card(), undefined, "the card is gone");
      assert.match(p.text(), /Restored your weekly routine: \d+ repeating events/);
      assert.deepEqual(p.server.unexpected, []);
    } finally {
      unmount();
    }
  });

  await check("CalendarApp: with the old Schedule page's week still saved in this browser, the page never reads it and offers nothing", async () => {
    const p = await openPage();
    try {
      const touched = [...p.storage.read, ...p.storage.written];
      assert.deepEqual(
        touched.filter((k) => /^oasis\.schedule|legacy/i.test(k)),
        [],
        `the page touches only its own keys: ${touched.join(", ") || "(none)"}`,
      );
      assert.equal(p.storage.scans, 0, "storage is never scanned for keys");
      const sidebar = p.sidebar();
      assert.ok(sidebar, "the sidebar is drawn");
      assert.equal("legacy" in sidebar, false, "the sidebar is not told this browser holds a week");
      assert.equal("onImportLegacy" in sidebar, false, "and has no import to run");
      assert.equal("onUseBrowserCopy" in p.card()!, false, "the restore card has no 'use that week instead' either");
      assert.doesNotMatch(p.text(), /still holds the week|Bring it into the calendar|Use that week instead|Use it instead of the restored routine|saved in this browser/i);
      assert.deepEqual(p.server.unexpected, [], "the page asked the server for the calendar and the routine, nothing else");
    } finally {
      unmount();
    }
  });

  await check("Sidebar: has no 'still holds the week' block, even when handed the old props", () => {
    const noop = () => undefined;
    const props = {
      cursor: FROM,
      now: FROM,
      prefs: DEFAULT_PREFS,
      calendars: [],
      busyDays: new Set<number>(),
      rangeStart: FROM,
      rangeEnd: FROM,
      onCreate: noop,
      onPick: noop,
      onToggle: noop,
      onAddCalendar: async () => undefined,
      onEditCalendar: async () => undefined,
      onDeleteCalendar: noop,
      onOpenSettings: noop,
    };
    const tree = mount(() => Sidebar({ ...props, legacy: "replace", onImportLegacy: noop } as never))();
    const text = ownText(tree).replace(/\s+/g, " ");
    assert.match(text, /My calendars/, "precondition: the sidebar's own markup was read");
    assert.doesNotMatch(text, /still holds the week|Bring it into the calendar|Use it instead of the restored routine|saved in this browser/i);
    assert.equal(elements(tree).filter((e) => e.type === "button" && /instead of the restored routine|Bring it into/.test(textOf(e.props.children))).length, 0);
  });

  await check("RoutineRestore: never offers this browser's old week, even when handed the old prop", () => {
    const tree = mount(() =>
      RoutineRestore({ info, prefs: DEFAULT_PREFS, calendarName: "Personal", now: FROM, onRestored: () => undefined, onDismiss: () => undefined, onUseBrowserCopy: () => undefined } as never),
    )();
    assert.match(flat(tree), /Restore my weekly routine/, "precondition: the card drew");
    assert.doesNotMatch(flat(tree), /This browser also holds|Use that week instead|saved on the old Schedule page, with any times/);
  });

  await check("The old browser-week import is gone from the source: no files, no storage keys, no wiring", () => {
    for (const gone of ["components/calendar/LegacyImport.tsx", "lib/calendar/legacy.ts"]) {
      assert.equal(existsSync(join(ROOT, gone)), false, `${gone} is deleted`);
    }
    for (const file of ["CalendarApp", "Sidebar", "RoutineRestore"]) {
      const src = readFileSync(join(ROOT, `components/calendar/${file}.tsx`), "utf8");
      assert.doesNotMatch(
        src,
        /oasis\.schedule|LEGACY_KEY_PREFIX|calendar\/legacy|LegacyImport|legacyImported|onImportLegacy|onUseBrowserCopy|localStorage\.key\(/,
        `${file} does not read the old page's storage or carry its import`,
      );
    }
    assert.doesNotMatch(
      readFileSync(join(ROOT, "components/calendar/Sidebar.tsx"), "utf8"),
      /still holds the week|Bring it into the calendar|Use it instead of the restored routine/,
      "the sidebar block is gone",
    );
  });

  // -- 5. "Edit times" fits a phone ---------------------------------------------
  // CC asked for a Schedule page where all the text fits. Measured in Chromium at a 320px viewport, "Edit times"
  // scrolled the card sideways (350px of content in a 320px card) and cut all nine block names ("W...") because
  // `.input` (globals.css) comes after Tailwind's utilities and beat the fields' own w-[6.5rem], px-2 and
  // text-[12px]: each field came out 125.7px wide in 14px type. This CI has no browser, so the rule that gives the
  // fields their size is pinned where it lives, in the real CSS, and the row's layout in the markup the card draws.
  const classesOf = (el: El) => String(el.props.className ?? "").split(/\s+/).filter(Boolean);
  const blockRows = (tree: unknown) => {
    const list = elements(tree).find((e) => e.type === "ul" && e.props["aria-label"] === "Blocks to restore");
    assert.ok(list, "the block list is drawn");
    const rows = Children.toArray(list.props.children as ReactNode).filter(isValidElement) as unknown as El[];
    return {
      list,
      rows: rows.map((row) => {
        const [times, name, days] = Children.toArray(row.props.children as ReactNode).filter(isValidElement) as unknown as El[];
        assert.ok(times && name && days, "a row is the times, the name and the days");
        return { row, times, name, days };
      }),
    };
  };
  const editing = () => {
    const edited = card(() => undefined);
    (button(edited(), /^Edit times$/).props.onClick as () => void)();
    return edited();
  };

  await check("Edit times: the time fields' sizing is a real rule in calendar.css, scoped to .input.routine-time", () => {
    const css = parse(readFileSync(join(ROOT, "components/calendar/calendar.css"), "utf8"));
    const found: Array<Record<string, string>> = [];
    css.walkRules((rule) => {
      // Top level only: inside a media query the sizing would hold on some widths and not others.
      if (rule.parent?.type !== "root" || !rule.selectors.includes(".cal .input.routine-time")) return;
      const declared: Record<string, string> = {};
      rule.walkDecls((decl) => void (declared[decl.prop] = decl.value));
      found.push(declared);
    });
    assert.equal(found.length, 1, "exactly one .cal .input.routine-time rule, outside any media query");
    assert.equal(found[0].width, "auto", "a field is as wide as its own text, which a wider font cannot clip the way a fixed width would");
    assert.equal(found[0]["padding-inline"], "0.5rem", "8px sides");
    assert.equal(found[0]["font-size"], "12px", "12px type");
  });

  await check("Edit times: every time field is .input.routine-time, and none carries a utility .input would silently beat", () => {
    const fields = elements(editing()).filter((e) => e.type === "input" && e.props.type === "time");
    assert.equal(fields.length, info.blocks.length * 2, "a start and an end for every block");
    for (const field of fields) {
      const classes = classesOf(field);
      assert.ok(classes.includes("input") && classes.includes("routine-time"), `${String(field.props["aria-label"])} is .input.routine-time (it is: ${classes.join(" ")})`);
      assert.deepEqual(
        classes.filter((c) => /^(w-|px-|text-\[)/.test(c)),
        [],
        `${String(field.props["aria-label"])}: a width, side padding or type size on .input is overridden by .input; the rule sizes the field`,
      );
    }
  });

  await check("Edit times: a row is two lines below sm (name and days, then the times), one line from sm, in one column, and nothing truncates", () => {
    const { list, rows } = blockRows(editing());
    assert.equal(rows.length, info.blocks.length, "a row for every block");
    assert.ok(!classesOf(list).includes("sm:grid-cols-2"), "the list is one column while editing: two columns leave a name about 70px");
    for (const { row, times, name, days } of rows) {
      assert.ok(classesOf(row).includes("flex-wrap"), "the row may wrap");
      for (const c of ["order-last", "w-full", "sm:order-none", "sm:w-auto"]) assert.ok(classesOf(times).includes(c), `the times take ${c}: below sm they are their own last line`);
      for (const c of ["min-w-0", "flex-1", "break-words"]) assert.ok(classesOf(name).includes(c), `the name takes ${c}: a long name wraps`);
      assert.ok(!classesOf(name).includes("truncate") && !classesOf(days).includes("truncate"), "no name or day is cut with an ellipsis");
      assert.ok(classesOf(days).includes("shrink-0"), "the days keep their width");
    }
  });

  await check("The restore card: names wrap instead of being cut, and the list is two columns from sm until editing", () => {
    const { list, rows } = blockRows(card(() => undefined)());
    assert.equal(rows.length, info.blocks.length, "a row for every block");
    assert.ok(classesOf(list).includes("sm:grid-cols-2"), "the unedited list keeps its two columns from sm");
    for (const { row, name, days } of rows) {
      assert.ok(classesOf(row).includes("flex-wrap"));
      for (const c of ["min-w-0", "flex-1", "break-words"]) assert.ok(classesOf(name).includes(c), `the name takes ${c}`);
      assert.ok(!classesOf(name).includes("truncate") && !classesOf(days).includes("truncate"), "no name or day is cut with an ellipsis");
    }
  });
  globalThis.setTimeout = realSetTimeout;

  if (failures) {
    console.error(`calendar-routine-card: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("calendar-routine-card: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
