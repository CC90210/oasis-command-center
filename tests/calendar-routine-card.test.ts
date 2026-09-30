/**
 * The routine restore card and the browser-week import, as the page runs them.
 *
 * WHY THIS EXISTS. Two defects the audit of PR #493 found in the client:
 *
 *   1. Restoring the routine and then clicking the old "Bring it into the
 *      calendar" import put every block in twice, in one click, with no
 *      confirm and no undo: the restore and the import write the same routine
 *      as separate rows and nothing linked them. Now the import asks first,
 *      and when the calendar already holds the restored routine it REPLACES
 *      it (lib/calendar/legacy.ts legacyImportWrites) instead of adding a
 *      second copy, in one request the page can undo.
 *   2. The card's restore wrapped everything, including onRestored (which runs
 *      after the server already answered 201), in a bare `catch {}` that
 *      logged nothing and always said "Could not reach the server". A network
 *      failure is now logged, and a failure after a successful write says the
 *      routine was saved.
 *   3. (CodeRabbit, PR #493) The import's confirm step wrote the writes planned
 *      when it OPENED. Opened while a restore was still in flight, it planned
 *      create-only writes on the empty calendar; confirmed after the restore
 *      landed, it put every block in twice. The writes are now worked out from
 *      the calendar as it is when confirmed, nothing is written while it is
 *      being read back, and the import is not offered while a restore is sent.
 *
 * The card is a client component; it runs here with a minimal stand-in for
 * React's hooks (no DOM), so its real click handlers are exercised. The page
 * (CalendarApp) runs one level deep: its own hooks and effects, against a
 * stand-in window and server; its children stay elements, never called.
 *
 * Run: node --conditions=react-server --import tsx tests/calendar-routine-card.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ReactNS from "react";
import { isValidElement, type ReactNode } from "react";

// The import runs in the viewer's browser, in the viewer's zone.
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
  const legacy = await import("../lib/calendar/legacy");
  const routine = await import("../lib/calendar/routine");
  const { expandOccurrences } = await import("../lib/calendar/recurrence");
  const { createPlaceholderSchedule } = await import("../lib/schedule/model");
  const { DEFAULT_PREFS } = await import("../lib/calendar/types");
  const { LIMITS } = await import("../lib/calendar/validate");
  const { LegacyImport } = await import("../components/calendar/LegacyImport");
  const { RoutineRestore, sendRoutineRestore } = await import("../components/calendar/RoutineRestore");
  type EventRecord = import("../lib/calendar/types").EventRecord;
  type EventInput = import("../lib/calendar/types").EventInput;

  const FROM = new Date("2026-09-30T12:00:00-04:00");
  const record = (e: EventInput, id: string): EventRecord => ({ ...e, id, createdAt: "", updatedAt: "" });
  // The routine as a restore wrote it, and this browser's old saved week.
  const restoredPlan = routine.buildRoutineSeries(routine.routineBlocks(), { calendarId: "cal", prefs: DEFAULT_PREFS, from: FROM });
  const restored = [...restoredPlan.series, ...restoredPlan.singles].map(({ event }, i) => record(event, `${routine.ROUTINE_ID_PREFIX}${i}`));
  const browserWeek = legacy.planLegacyImport(createPlaceholderSchedule(FROM), "cal", "America/Toronto", DEFAULT_PREFS);
  // An event the user made, and a one-day edit made to a restored series.
  const dentist: EventRecord = { ...restored[0], id: "user-dentist", title: "Dentist", recurrence: null, exdates: [] };
  const override: EventRecord = { ...restored[0], id: "user-override", title: "Wake up late", recurrence: null, recurringEventId: restored[0].id, originalStart: restored[0].start };

  /** The calendar after a batch list is applied in order (creates get fresh ids). */
  const apply = (rows: EventRecord[], batches: import("../lib/calendar/types").EventOp[][]) => {
    let next = rows;
    let n = 0;
    for (const op of batches.flat()) {
      if (op.op === "create") next = [...next, record(op.event, `new-${n++}`)];
      else if (op.op === "delete") next = next.filter((r) => r.id !== op.id);
    }
    return next;
  };
  const wednesday = (rows: EventRecord[]) =>
    expandOccurrences(rows, new Date(2026, 9, 7), new Date(2026, 9, 8))
      .filter((o) => o.event.calendarId === "cal")
      .map((o) => o.event.title)
      .sort();

  // ── 1. The import's writes ─────────────────────────────────────────────────
  await check("precondition: importing the browser week on top of the restored routine doubles every block", () => {
    assert.ok(browserWeek.events.length > 0 && restored.length > 0);
    const naive = apply(restored, [browserWeek.events.map((event) => ({ op: "create" as const, event }))]);
    assert.equal(wednesday(naive).filter((t) => t === "Wake up").length, 2);
  });

  await check("legacyImportWrites: with the routine restored, the browser week replaces it and each block is in once", () => {
    const existing = [...restored, override, dentist];
    const writes = legacy.legacyImportWrites(browserWeek.events, existing);
    assert.equal(writes.replacing, restored.length + 1, "the restored rows and the one-day edit made to them");
    const ops = writes.batches.flat();
    const deletes = ops.filter((o) => o.op === "delete").map((o) => (o as { id: string }).id).sort();
    assert.deepEqual(deletes, [...restored.map((r) => r.id), "user-override"].sort());
    assert.ok(!deletes.includes("user-dentist"), "an event the user made is never touched");
    const lastCreate = ops.map((o) => o.op).lastIndexOf("create");
    const firstDelete = ops.map((o) => o.op).indexOf("delete");
    assert.ok(lastCreate < firstDelete, "every create lands before anything is removed");
    assert.ok(writes.batches[writes.batches.length - 1].some((o) => o.op === "delete"), "the removal rides with the last creates");
    const after = apply(existing, writes.batches);
    const titles = wednesday(after);
    assert.deepEqual(titles.filter((t) => t !== "Dentist"), [...new Set(titles.filter((t) => t !== "Dentist"))], `each block once: ${titles.join(", ")}`);
    assert.ok(titles.includes("Wake up") && titles.includes("Agent training / R&D"));
  });

  await check("legacyImportWrites: the whole import, removal included, is ONE request (one undo, never half-applied)", () => {
    const replace = legacy.legacyImportWrites(browserWeek.events, restored);
    assert.equal(replace.batches.length, 1, `${browserWeek.events.length} creates + ${restored.length} deletes in one request`);
    assert.ok(replace.batches[0].length <= LIMITS.opsPerBatch, "within the server's per-request limit");
    const add = legacy.legacyImportWrites(browserWeek.events, [dentist]);
    assert.equal(add.replacing, 0);
    assert.equal(add.batches.length, 1);
    assert.ok(add.batches[0].every((o) => o.op === "create") && add.batches[0].length === browserWeek.events.length, "without a restored routine it only adds");
    assert.deepEqual(legacy.legacyImportWrites([], restored), { batches: [], replacing: 0 }, "an empty import never deletes the routine");
  });

  await check("legacyImportWrites: past the per-request limit it splits, creates first and the removal last", () => {
    const many = Array.from({ length: 130 }, () => browserWeek.events[0]);
    const kinds = (b: import("../lib/calendar/types").EventOp[][]) => b.map((ops) => `${ops.filter((o) => o.op === "create").length}c${ops.filter((o) => o.op === "delete").length}d`);
    assert.deepEqual(kinds(legacy.legacyImportWrites(many, restored, 60).batches), ["60c0d", "60c0d", `10c${restored.length}d`]);
    assert.deepEqual(kinds(legacy.legacyImportWrites(many.slice(0, 55), restored, 60).batches), ["55c0d", `0c${restored.length}d`], "a removal that does not fit goes in its own last request");
  });

  // ── 2. The confirm step ───────────────────────────────────────────────────
  const dialog = (p: Partial<Parameters<typeof LegacyImport>[0]>) => {
    const calls: string[] = [];
    const tree = mount(() =>
      LegacyImport({
        adds: 54,
        singles: 0,
        replacing: 0,
        calendarName: "Personal",
        adjusted: [],
        skipped: [],
        busy: false,
        onConfirm: () => calls.push("confirm"),
        onCancel: () => calls.push("cancel"),
        ...p,
      }),
    )();
    return { tree, text: flat(tree), calls };
  };

  await check("The import asks first: it says what it adds, and replacing the restored routine is spelled out", () => {
    const add = dialog({});
    assert.match(add.text, /Bring in this browser.s saved week\?/);
    assert.match(add.text, /This adds 54 repeating events to Personal/);
    (button(add.tree, /^Add them$/).props.onClick as () => void)();
    assert.deepEqual(add.calls, ["confirm"]);

    // The browser week as planned: the shortened Fridays are single events, not repeating ones.
    const singles = browserWeek.events.filter((e) => !e.recurrence).length;
    assert.ok(singles > 0, "precondition: the saved week has Fridays shortened for Shabbat");
    const mixed = dialog({ adds: browserWeek.events.length, singles });
    assert.match(
      mixed.text,
      new RegExp(`This adds ${browserWeek.events.length - singles} repeating events and ${singles} single events shortened for Shabbat to Personal`),
    );
    assert.doesNotMatch(mixed.text, new RegExp(`${browserWeek.events.length} repeating`), "never counts a single week as a repeating event");

    const replace = dialog({ replacing: 37 });
    assert.match(replace.text, /Replace the restored routine\?/);
    assert.match(replace.text, /Personal already has the weekly routine restored from the old Schedule page \(37 events\)/);
    assert.match(replace.text, /would put each block in twice/);
    assert.match(replace.text, /Replacing removes those 37 events, with any changes you made to them, and adds 54 events/);
    const keep = button(replace.tree, /^Keep the restored routine$/);
    assert.equal(keep.props["data-autofocus"], true, "the safe choice has the focus");
    (keep.props.onClick as () => void)();
    (button(replace.tree, /^Replace them$/).props.onClick as () => void)();
    assert.deepEqual(replace.calls, ["cancel", "confirm"]);

    const busy = dialog({ replacing: 37, busy: true });
    assert.equal(button(busy.tree, /^Replacing/).props.disabled, true);
    (button(busy.tree, /^Keep the restored routine$/).props.onClick as () => void)();
    assert.deepEqual(busy.calls, [], "it cannot be cancelled while it writes");

    const none = dialog({ adds: 0, replacing: 37, skipped: ["fri Agent training / R&D"] });
    assert.match(none.text, /Nothing to bring in/);
    assert.doesNotMatch(none.text, /Replac/, "nothing is removed when nothing is added");
    assert.match(none.text, /Left out, every week falls inside Shabbat: fri Agent training \/ R&D\./);
  });

  await check("CalendarApp: the sidebar and the card open the confirm step; the import writes through legacyImportWrites", () => {
    const src = readFileSync(join(ROOT, "components/calendar/CalendarApp.tsx"), "utf8");
    assert.match(src, /onImportLegacy=\{askLegacy\}/);
    assert.match(src, /onUseBrowserCopy=\{legacyMode \? askLegacy : undefined\}/);
    assert.match(src, /legacyImportWrites\(plan\.events, events\)/);
    assert.match(src, /<LegacyImport[\s\S]*?onConfirm=\{\(\) => void importLegacy\(\)\}/);
    assert.match(src, /restoredRoutineIds\(events\)\.length \? "replace" : "add"/);
    assert.match(src, /setRoutineSyncing\(true\);\s*void data\.reload\(\)\.finally\(\(\) => setRoutineSyncing\(false\)\)/);
    assert.match(src, /singles=\{legacyAsk\.plan\.events\.filter\(\(e\) => !e\.recurrence\)\.length\}/, "the dialog is told which events do not repeat");
  });

  await check("CalendarApp: the restore card shows only on an EMPTY calendar; a client's first paint has no city and no lock", () => {
    const src = readFileSync(join(ROOT, "components/calendar/CalendarApp.tsx"), "utf8");
    // Restoring on top of events already there (a browser-week import, say) would put every block in twice.
    assert.match(src, /const emptyCalendar = data\.load\.status === "ready" && events\.length === 0;/);
    assert.match(src, /\{emptyCalendar && routine && routineState === "checked" && \(\s*<RoutineRestore/);
    assert.match(src, /if \(emptyCalendar && !routineAsked\.current\) void checkRoutine\(\);/, "the server is asked only for an empty calendar");
    const data = readFileSync(join(ROOT, "components/calendar/useCalendarData.ts"), "utf8");
    assert.match(data, /useState<CalendarPrefs>\(NEUTRAL_PREFS\)/, "until the server answers: no place, no Shabbat lock");
  });

  // ── 3. The restore request ─────────────────────────────────────────────────
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

  // ── 4. The card, clicked through ────────────────────────────────────────────
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

  await check("RoutineRestore: with this browser's old week saved, the card offers it as the alternative", () => {
    const opened: string[] = [];
    const tree = mount(() =>
      RoutineRestore({ info, prefs: DEFAULT_PREFS, calendarName: "Personal", now: FROM, onRestored: () => undefined, onDismiss: () => undefined, onUseBrowserCopy: () => opened.push("legacy") }),
    )();
    assert.match(flat(tree), /This browser also holds the week you last saved on the old Schedule page/);
    (button(tree, /^Use that week instead$/).props.onClick as () => void)();
    assert.deepEqual(opened, ["legacy"]);
    const without = card(() => undefined)();
    assert.doesNotMatch(flat(without), /This browser also holds/);
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

  // ── 5. The page, run: the import writes from the calendar as it is when confirmed ──
  // A client component's stylesheet import is the bundler's business.
  (require as unknown as { extensions: Record<string, (m: { exports: unknown }) => void> }).extensions[".css"] = (m) => void (m.exports = {});
  const { CalendarApp } = await import("../components/calendar/CalendarApp");
  const { Sidebar } = await import("../components/calendar/Sidebar");
  type EventOp = import("../lib/calendar/types").EventOp;
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

  /** CalendarApp on an empty calendar, with the routine restorable and this browser's old week saved. */
  async function openPage() {
    const server = { events: [] as EventRecord[], posts: [] as EventOp[][], reads: 0, unexpected: [] as string[], hold: null as Promise<void> | null };
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const cal = { id: "cal", name: "Personal", color: "tide", visible: true, isDefault: true, position: 0, createdAt: "", updatedAt: "" };
    let seq = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(url);
      if (method === "GET" && path === "/api/calendar") {
        if (server.hold) await server.hold;
        server.reads += 1;
        return json(200, { ok: true, calendars: [cal], events: server.events, prefs: DEFAULT_PREFS, truncated: false });
      }
      if (method === "GET" && path === "/api/calendar/routine") return json(200, { ok: true, ...info });
      if (method === "POST" && path === "/api/calendar/events") {
        const { ops } = JSON.parse(String(init?.body)) as { ops: EventOp[] };
        server.posts.push(ops);
        const results = ops.map((op) => {
          if (op.op === "create") {
            const row = record(op.event, `srv-${seq++}`);
            server.events = [...server.events, row];
            return { op: "create", id: row.id, tempId: op.tempId, event: row };
          }
          if (op.op === "delete") {
            server.events = server.events.filter((r) => r.id !== op.id);
            return { op: "delete", id: op.id };
          }
          throw new Error(`unexpected op ${op.op}`);
        });
        return json(200, { ok: true, results });
      }
      server.unexpected.push(`${method} ${path}`);
      return json(500, { ok: false, error: "unexpected" });
    }) as typeof fetch;
    const stored = new Map([[`${legacy.LEGACY_KEY_PREFIX}.week`, JSON.stringify(createPlaceholderSchedule(FROM))]]);
    (globalThis as unknown as { window: unknown }).window = {
      innerWidth: 1280,
      localStorage: {
        get length() {
          return stored.size;
        },
        key: (i: number) => [...stored.keys()][i] ?? null,
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, String(v)),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const page = mount(() => CalendarApp());
    let tree: unknown = page();
    const of = <P,>(type: unknown) => shallow(tree).find((e) => e.type === type)?.props as P | undefined;
    const p = {
      server,
      /** Renders, runs the effects, lets the requests answer, and renders again. */
      async settle() {
        for (let k = 0; k < 4; k++) {
          flushEffects();
          await settle();
          tree = page();
        }
      },
      render: () => void (tree = page()),
      text: () => ownText(tree).replace(/\s+/g, " "),
      card: () => of<Parameters<typeof RoutineRestore>[0]>(RoutineRestore),
      dialog: () => of<Parameters<typeof LegacyImport>[0]>(LegacyImport),
      sidebar: () => of<Parameters<typeof Sidebar>[0]>(Sidebar),
    };
    await p.settle();
    assert.ok(p.card()?.onUseBrowserCopy, `precondition: the restore card offers this browser's week: ${p.text()}`);
    assert.equal(p.sidebar()?.legacy, "add");
    return p;
  }
  // A toast's 5-second timer must not hold the run open.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const t = realSetTimeout(fn, ms, ...rest);
    if ((ms ?? 0) >= 1000) t.unref();
    return t;
  }) as typeof setTimeout;

  await check("CalendarApp: a restore that lands while the import's confirm step is open turns it into a replace, never a second copy", async () => {
    const p = await openPage();
    try {
      // Opened on the empty calendar (a restore still in flight), it plans to add.
      p.card()!.onUseBrowserCopy!();
      p.render();
      assert.equal(p.dialog()?.adds, browserWeek.events.length);
      assert.equal(p.dialog()?.replacing, 0, "planned on the empty calendar, it only adds");
      // The restore lands under the open dialog and the calendar is read back.
      p.server.events = restored;
      p.card()!.onRestored({ status: "restored", created: restored, adjusted: [], dropped: [] });
      await p.settle();
      const shown = p.dialog()?.replacing;
      p.dialog()!.onConfirm();
      await p.settle();
      assert.equal(p.server.posts.length, 1, "one request");
      const ops = p.server.posts[0];
      assert.deepEqual(
        ops.filter((o) => o.op === "delete").map((o) => (o as { id: string }).id).sort(),
        restored.map((r) => r.id).sort(),
        "the restored routine is replaced, not doubled",
      );
      assert.equal(ops.filter((o) => o.op === "create").length, browserWeek.events.length);
      const titles = wednesday(p.server.events);
      assert.deepEqual(titles, [...new Set(titles)], `each block once on the server: ${titles.join(", ")}`);
      assert.ok(titles.includes("Wake up") && titles.includes("Agent training / R&D"));
      assert.equal(shown, restored.length, "and the dialog said so before it was confirmed");
      assert.equal(p.dialog(), undefined, "the confirm step closed");
      assert.deepEqual(p.server.unexpected, []);
    } finally {
      unmount();
    }
  });

  await check("CalendarApp: confirmed while the calendar is still being read back, the import writes nothing and says so", async () => {
    const p = await openPage();
    try {
      p.card()!.onUseBrowserCopy!();
      p.render();
      let release!: () => void;
      p.server.hold = new Promise<void>((r) => (release = r));
      p.server.events = restored;
      p.card()!.onRestored({ status: "restored", created: restored, adjusted: [], dropped: [] });
      await p.settle();
      p.dialog()!.onConfirm();
      await p.settle();
      assert.equal(p.server.posts.length, 0, "nothing is written against a calendar that is not current");
      assert.match(p.text(), /The calendar is still catching up, so nothing was imported yet\. Try again in a moment\./);
      assert.ok(p.dialog(), "the confirm step stays open");
      p.server.hold = null;
      release();
      await p.settle();
      assert.equal(p.dialog()?.replacing, restored.length);
      p.dialog()!.onConfirm();
      await p.settle();
      assert.equal(p.server.posts.length, 1);
      const titles = wednesday(p.server.events);
      assert.deepEqual(titles, [...new Set(titles)], `each block once on the server: ${titles.join(", ")}`);
    } finally {
      unmount();
    }
  });

  await check("CalendarApp: from the moment a restore is sent until the calendar is read back, the browser week is not offered", async () => {
    const p = await openPage();
    try {
      p.card()!.onRestoring!(true);
      p.render();
      assert.equal(p.sidebar()?.legacy, null, "the sidebar does not offer it");
      assert.equal(p.card()?.onUseBrowserCopy, undefined, "nor does the card");
      // The restore failed, but its rows were saved before the reply was lost: the read-back finds them.
      const reads = p.server.reads;
      p.server.events = restored;
      p.card()!.onRestoring!(false);
      await p.settle();
      assert.equal(p.server.reads, reads + 1, "a failed restore is read back before the import is offered again");
      assert.equal(p.sidebar()?.legacy, "replace", "offered again as a replace of the routine the server holds");
      assert.equal(p.card(), undefined, "the calendar is not empty any more, so the card is gone");
    } finally {
      unmount();
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
