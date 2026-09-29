"use client";

import "./calendar.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  addMonths,
  formatRangeTitle,
  formatShortDate,
  formatTime,
  fromDateKey,
  isDateKey,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toDateKey,
} from "@/lib/calendar/dates";
import { LEGACY_KEY_PREFIX, pickLegacyWeek, planLegacyImport } from "@/lib/calendar/legacy";
import { eventStart, expandOccurrences, inputOf, planDelete, planEdit, sameRule } from "@/lib/calendar/recurrence";
import type { CalendarView, EditScope, EventInput, EventOp, Occurrence } from "@/lib/calendar/types";
import { shabbatConflict, validateEventInput } from "@/lib/calendar/validate";
import { DayListPopover } from "./DayListPopover";
import { EventEditor } from "./EventEditor";
import { EventPopover } from "./EventPopover";
import { MonthView } from "./MonthView";
import { QuickCreate } from "./QuickCreate";
import { ScheduleView } from "./ScheduleView";
import { ScopeDialog } from "./ScopeDialog";
import { SettingsDialog } from "./SettingsDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { TimeGrid } from "./TimeGrid";
import { Toolbar } from "./Toolbar";
import { CalendarApiError, messageFor, useCalendarData } from "./useCalendarData";
import { useReminders } from "./useReminders";
import { YearView } from "./YearView";
import { anchorOf, draftFor, inputForOccurrence, localTimeZone, visibleCalendarIds, type Anchor } from "./ui";

type Panel =
  | { kind: "view"; occ: Occurrence; anchor: Anchor | null }
  | { kind: "quick"; draft: EventInput; anchor: Anchor | null }
  | { kind: "editor"; draft: EventInput; occ: Occurrence | null }
  | { kind: "scope"; action: "edit" | "delete"; occ: Occurrence; next?: EventInput; fromEditor: boolean }
  | { kind: "day"; day: Date; anchor: Anchor | null }
  | { kind: "settings" }
  | { kind: "shortcuts" }
  | { kind: "goto" };

type Toast = { id: number; text: string; undo?: EventOp[]; tone?: "error" };

const VIEW_KEY = "oasis.calendar.view";
const IMPORTED_KEY = "oasis.calendar.legacyImported";
const VIEWS: CalendarView[] = ["day", "4day", "week", "month", "year", "schedule"];

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* A remembered view is a convenience; losing it is harmless. */
  }
}

export function CalendarApp() {
  const data = useCalendarData();
  const { calendars, events, prefs, commit } = data;
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("week");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [legacy, setLegacy] = useState<string[] | null>(null);
  const lastUndo = useRef<EventOp[] | null>(null);
  const lastError = useRef<string>("");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    const saved = readLocal(VIEW_KEY) as CalendarView | null;
    const narrow = window.innerWidth < 768;
    if (saved && VIEWS.includes(saved)) setView(saved);
    else if (narrow) setView("4day"); // seven columns do not fit a phone
    if (narrow) setSidebar(false);
    try {
      if (!readLocal(IMPORTED_KEY)) {
        const raws: string[] = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k?.startsWith(LEGACY_KEY_PREFIX)) raws.push(window.localStorage.getItem(k) ?? "");
        }
        if (raws.length) setLegacy(raws);
      }
    } catch {
      /* No storage, nothing to import. */
    }
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((text: string, extra: Partial<Toast> = {}) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, ...extra }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), extra.undo ? 8000 : 5000);
  }, []);

  const calMap = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const visibleIds = useMemo(() => visibleCalendarIds(calendars), [calendars]);
  const defaultCalendarId = calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id ?? "";

  // ── Visible range ──────────────────────────────────────────────────────
  const range = useMemo(() => {
    if (view === "day") return { start: cursor, end: addDays(cursor, 1) };
    if (view === "4day") return { start: cursor, end: addDays(cursor, 4) };
    if (view === "week") {
      const s = startOfWeek(cursor, prefs.weekStartsOn);
      return { start: s, end: addDays(s, 7) };
    }
    if (view === "month") {
      const s = startOfWeek(startOfMonth(cursor), prefs.weekStartsOn);
      return { start: s, end: addDays(s, 42) };
    }
    if (view === "year") return { start: new Date(cursor.getFullYear(), 0, 1), end: new Date(cursor.getFullYear() + 1, 0, 1) };
    return { start: cursor, end: addDays(cursor, 90) };
  }, [view, cursor, prefs.weekStartsOn]);

  const days = useMemo(() => {
    const n = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000);
    const list = Array.from({ length: Math.min(n, 7) }, (_, i) => addDays(range.start, i));
    return view === "week" && !prefs.showWeekends ? list.filter((d) => d.getDay() !== 0 && d.getDay() !== 6) : list;
  }, [range, view, prefs.showWeekends]);

  const visible = useCallback((list: Occurrence[]) => list.filter((o) => visibleIds.has(o.event.calendarId)), [visibleIds]);
  const occurrences = useMemo(() => visible(expandOccurrences(events, range.start, range.end)), [events, range, visible]);

  const miniRange = useMemo(() => {
    const s = startOfWeek(startOfMonth(cursor), prefs.weekStartsOn);
    return { start: s, end: addDays(s, 42) };
  }, [cursor, prefs.weekStartsOn]);
  const busyDays = useMemo(() => {
    const set = new Set<number>();
    for (const o of visible(expandOccurrences(events, miniRange.start, miniRange.end))) set.add(startOfDay(o.start).getTime());
    return set;
  }, [events, miniRange, visible]);

  // Reminders can be up to four weeks ahead (the validator's ceiling), so the
  // lookup spans that; the hook itself only arms those due in the next 12h.
  const upcoming = useMemo(() => visible(expandOccurrences(events, now, new Date(now.getTime() + 29 * 86_400_000))), [events, now, visible]);
  const reminders = useReminders(upcoming, (text) => toast(text));

  const results = useMemo(() => {
    if (query === null || !query.trim()) return null;
    const q = query.trim().toLowerCase();
    const all = visible(expandOccurrences(events, addDays(now, -365), addDays(now, 365)));
    return all.filter((o) => [o.event.title, o.event.location, o.event.description, ...o.event.guests].some((f) => f.toLowerCase().includes(q)));
  }, [query, events, now, visible]);

  // ── Navigation ─────────────────────────────────────────────────────────
  const changeView = useCallback((v: CalendarView) => {
    setView(v);
    writeLocal(VIEW_KEY, v);
  }, []);
  const step = useCallback(
    (dir: -1 | 1) => {
      setCursor((c) => {
        if (view === "day") return addDays(c, dir);
        if (view === "4day") return addDays(c, 4 * dir);
        if (view === "week") return addDays(c, 7 * dir);
        if (view === "month") return startOfMonth(addMonths(c, dir));
        if (view === "year") return new Date(c.getFullYear() + dir, 0, 1);
        return addDays(c, 30 * dir);
      });
    },
    [view],
  );
  const pickDay = useCallback((d: Date) => {
    setCursor(startOfDay(d));
    setPanel(null);
  }, []);
  const openDay = useCallback((d: Date) => {
    pickDay(d);
    changeView("day");
  }, [pickDay, changeView]);

  const title =
    view === "month" ? formatRangeTitle(cursor, cursor, "month")
      : view === "year" ? formatRangeTitle(cursor, cursor, "year")
        : view === "day" ? formatRangeTitle(cursor, cursor, "day")
          : formatRangeTitle(range.start, addDays(range.end, -1), "range");

  // ── Writes ─────────────────────────────────────────────────────────────
  const conflictText = (input: EventInput): string | null => {
    const hit = shabbatConflict(input, prefs);
    if (!hit) return null;
    return `That overlaps Shabbat (${formatShortDate(hit.start)}, ${formatTime(hit.start)} to ${formatShortDate(hit.end)}, ${formatTime(hit.end)}), which is protected. Pick another time${input.recurrence ? ", or end the series before then" : ""}.`;
  };

  const mergedInput = (id: string, patch: Partial<EventInput>): EventInput | null => {
    const row = events.find((e) => e.id === id);
    return row ? { ...inputOf(row), ...patch } : null;
  };

  const run = useCallback(
    async (ops: EventOp[], done: string, undoable = true) => {
      try {
        const inverse = await commit(ops);
        lastUndo.current = undoable ? inverse : null;
        toast(done, undoable ? { undo: inverse } : {});
        return true;
      } catch (err) {
        const msg = err instanceof CalendarApiError ? err.message : messageFor("");
        lastError.current = msg;
        toast(msg, { tone: "error" });
        return false;
      }
    },
    [commit, toast],
  );

  const undo = useCallback(
    async (ops: EventOp[]) => {
      lastUndo.current = null;
      setToasts([]);
      await run(ops, "Undone", false);
    },
    [run],
  );

  /** Saves a draft from the quick panel or editor. `occ` is null for a new event. */
  const saveDraft = async (draft: EventInput, occ: Occurrence | null, fromEditor: boolean) => {
    const checked = validateEventInput({ ...draft, title: draft.title.trim() });
    if (!checked.ok) {
      setPanelError(checked.error === "end_before_start" ? "The event has to end after it starts." : "Some details are not valid. Check the dates and guest emails.");
      return;
    }
    // A repeating event is checked after the scope is chosen: a one-day edit
    // must not be refused because of a winter Friday elsewhere in the series.
    if (occ?.master) {
      setPanel({ kind: "scope", action: "edit", occ, next: checked.value, fromEditor });
      return;
    }
    const clash = conflictText(checked.value);
    if (clash) return setPanelError(clash);
    const ops: EventOp[] = occ ? [{ op: "update", id: occ.event.id, patch: checked.value }] : [{ op: "create", event: checked.value }];
    setPanel(null);
    // A failed save must not cost the user what they typed: reopen it.
    if (!(await run(ops, occ ? "Event saved" : "Event created"))) {
      setPanelError(lastError.current);
      setPanel({ kind: "editor", draft, occ });
    }
  };

  const applyScope = async (scope: EditScope) => {
    if (panel?.kind !== "scope") return;
    const { occ, next, action, fromEditor } = panel;
    if (action === "delete") {
      setPanel(null);
      await run(planDelete(occ, scope, events), "Event deleted");
      return;
    }
    if (!next) return setPanel(null);
    const ops = planEdit(occ, next, scope, events);
    // Check exactly what will be written: each created event, and each
    // updated row as it will stand after the patch.
    for (const op of ops) {
      const after = op.op === "create" ? op.event : op.op === "update" ? mergedInput(op.id, op.patch) : null;
      const clash = after && conflictText(after);
      if (!clash) continue;
      if (fromEditor) {
        setPanelError(clash);
        setPanel({ kind: "editor", draft: next, occ });
      } else {
        setPanel(null);
        toast(clash, { tone: "error" });
      }
      return;
    }
    setPanel(null);
    if (!(await run(ops, "Event saved")) && fromEditor) {
      setPanelError(lastError.current);
      setPanel({ kind: "editor", draft: next, occ });
    }
  };

  const moveOcc = (occ: Occurrence, start: Date, end: Date) => {
    const base = inputForOccurrence(occ);
    const next: EventInput = occ.allDay
      ? { ...base, start: toDateKey(start), end: toDateKey(end) }
      : { ...base, start: start.toISOString(), end: end.toISOString() };
    // Repeating events are checked once the scope is chosen (applyScope).
    if (occ.master) return setPanel({ kind: "scope", action: "edit", occ, next, fromEditor: false });
    const clash = conflictText(next);
    if (clash) return toast(clash, { tone: "error" });
    void run([{ op: "update", id: occ.event.id, patch: next }], "Event moved");
  };

  const moveToDay = (occ: Occurrence, day: Date) => {
    const shift = Math.round((startOfDay(day).getTime() - startOfDay(occ.start).getTime()) / 86_400_000);
    moveOcc(occ, addDays(occ.start, shift), addDays(occ.end, shift));
  };

  const deleteOcc = (occ: Occurrence) => {
    if (occ.master) return setPanel({ kind: "scope", action: "delete", occ, fromEditor: false });
    setPanel(null);
    void run([{ op: "delete", id: occ.event.id }], "Event deleted");
  };

  const create = (start: Date, end: Date | null, allDay: boolean, anchor: Anchor | null) => {
    if (!defaultCalendarId) return;
    setPanelError(null);
    setPanel({ kind: "quick", draft: draftFor(start, end, allDay, defaultCalendarId, prefs), anchor });
  };

  const createNow = () => {
    const base = view === "month" || view === "year" || view === "schedule" ? cursor : startOfDay(now) >= range.start && now < range.end ? now : cursor;
    const start = new Date(base);
    if (base === cursor) start.setHours(9, 0, 0, 0);
    else start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
    setPanelError(null);
    setPanel({ kind: "editor", draft: draftFor(start, null, false, defaultCalendarId, prefs), occ: null });
  };

  const importLegacy = async () => {
    const doc = legacy && pickLegacyWeek(legacy);
    if (!doc || !defaultCalendarId) return setLegacy(null);
    const plan = planLegacyImport(doc, defaultCalendarId, localTimeZone(), prefs);
    let ok = true;
    for (let i = 0; i < plan.events.length && ok; i += 60) {
      ok = await run(plan.events.slice(i, i + 60).map((event) => ({ op: "create" as const, event })), "Importing…", false);
    }
    if (!ok) return;
    writeLocal(IMPORTED_KEY, new Date().toISOString());
    setLegacy(null);
    const skipped = plan.skippedForShabbat.length ? ` ${plan.skippedForShabbat.length} Friday block(s) overlap winter Shabbat and were left out: ${plan.skippedForShabbat.join(", ")}.` : "";
    toast(`Imported ${plan.events.length} repeating events from your old weekly routine.${skipped}`);
  };

  // ── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (lastUndo.current && !panel) {
          e.preventDefault();
          void undo(lastUndo.current);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || panel) return;
      const map: Record<string, () => void> = {
        t: () => setCursor(startOfDay(new Date())),
        j: () => step(1),
        n: () => step(1),
        k: () => step(-1),
        p: () => step(-1),
        d: () => changeView("day"),
        x: () => changeView("4day"),
        w: () => changeView("week"),
        m: () => changeView("month"),
        y: () => changeView("year"),
        a: () => changeView("schedule"),
        c: () => createNow(),
        g: () => setPanel({ kind: "goto" }),
        "/": () => setQuery(""),
        "?": () => setPanel({ kind: "shortcuts" }),
      };
      const fn = map[e.key.toLowerCase()] ?? map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Render ─────────────────────────────────────────────────────────────
  const selectedKey = panel?.kind === "view" ? panel.occ.key : null;
  const openOcc = (occ: Occurrence, el: HTMLElement) => setPanel({ kind: "view", occ, anchor: anchorOf(el) });

  let body: React.ReactNode;
  if (data.load.status === "loading") {
    body = <p className="grid h-full place-items-center text-sm text-fg-muted" role="status">Loading your calendar…</p>;
  } else if (data.load.status === "error") {
    body = (
      <div className="grid h-full place-items-center p-6">
        <div role="alert" className="max-w-md rounded-lg border border-hairline bg-bg-panel p-5 text-sm">
          <p className="font-semibold text-fg">The calendar could not load</p>
          <p className="mt-1 text-fg-muted">{data.load.message}</p>
          <button type="button" className="btn mt-4" onClick={() => void data.reload()}>Try again</button>
        </div>
      </div>
    );
  } else if (results) {
    body = <ScheduleView occurrences={results} calendars={calMap} now={now} selectedKey={selectedKey} onOpen={openOcc} onPickDay={openDay} heading={`${results.length} result${results.length === 1 ? "" : "s"} within a year of today`} emptyText="Nothing matches that search." />;
  } else if (view === "month") {
    body = <MonthView anchor={cursor} occurrences={occurrences} calendars={calMap} prefs={prefs} now={now} selectedKey={selectedKey} onOpen={openOcc} onCreate={create} onMoveToDay={moveToDay} onPickDay={openDay} onShowMore={(day, el) => setPanel({ kind: "day", day, anchor: anchorOf(el) })} suppressCreate={panel !== null} />;
  } else if (view === "year") {
    body = <YearView year={cursor.getFullYear()} occurrences={occurrences} now={now} weekStartsOn={prefs.weekStartsOn} onPickDay={openDay} />;
  } else if (view === "schedule") {
    body = <ScheduleView occurrences={occurrences} calendars={calMap} now={now} selectedKey={selectedKey} onOpen={openOcc} onPickDay={openDay} emptyText="Nothing scheduled in the next 90 days." />;
  } else {
    body = <TimeGrid days={days} occurrences={occurrences} calendars={calMap} prefs={prefs} now={now} selectedKey={selectedKey} onOpen={openOcc} onCreate={create} onMove={moveOcc} onPickDay={openDay} suppressCreate={panel !== null} />;
  }

  return (
    <div className="cal relative flex h-full min-h-0 flex-col bg-bg">
      <Toolbar
        title={title}
        view={view}
        query={query}
        saving={data.saving}
        onMenu={() => setSidebar((s) => !s)}
        onToday={() => setCursor(startOfDay(new Date()))}
        onStep={step}
        onView={changeView}
        onQuery={setQuery}
        onSettings={() => setPanel({ kind: "settings" })}
        onShortcuts={() => setPanel({ kind: "shortcuts" })}
      />
      {data.truncated && <p className="border-b border-hairline bg-status-warm/10 px-4 py-1.5 text-[12px] text-fg">Showing your first 5,000 events. Older ones are not loaded.</p>}
      <div className="relative flex min-h-0 flex-1">
        {sidebar && (
          <>
            <div className="fixed inset-0 z-30 bg-bg-rail/60 md:hidden" onClick={() => setSidebar(false)} aria-hidden />
            <aside className="fixed inset-y-0 left-0 z-40 w-[256px] border-r border-hairline bg-bg md:static md:z-auto md:w-[248px] md:shrink-0">
              <Sidebar
                cursor={cursor}
                now={now}
                prefs={prefs}
                calendars={calendars}
                busyDays={busyDays}
                rangeStart={view === "week" || view === "4day" || view === "day" ? range.start : cursor}
                rangeEnd={view === "week" || view === "4day" || view === "day" ? range.end : cursor}
                legacyAvailable={!!legacy && data.load.status === "ready"}
                onCreate={createNow}
                onPick={(d) => {
                  pickDay(d);
                  if (window.innerWidth < 768) setSidebar(false);
                }}
                onToggle={(c) => void data.patchCalendar(c.id, { visible: !c.visible }).catch((e: Error) => toast(e.message, { tone: "error" }))}
                onAddCalendar={async (name, color) => void (await data.addCalendar(name, color))}
                onEditCalendar={(c, patch) => data.patchCalendar(c.id, patch)}
                onDeleteCalendar={(c) => {
                  if (!window.confirm(`Delete "${c.name}" and every event in it? This cannot be undone.`)) return;
                  data.removeCalendar(c.id).then(() => toast(`Deleted ${c.name}`)).catch((e: Error) => toast(e.message, { tone: "error" }));
                }}
                onImportLegacy={() => void importLegacy()}
              />
            </aside>
          </>
        )}
        <div role="region" aria-label="Calendar" className="min-w-0 flex-1">{body}</div>
      </div>

      {panel?.kind === "view" && (
        <EventPopover
          occ={panel.occ}
          anchor={panel.anchor}
          calendars={calMap}
          onClose={() => setPanel(null)}
          onEdit={() => {
            setPanelError(null);
            setPanel({ kind: "editor", draft: inputForOccurrence(panel.occ), occ: panel.occ });
          }}
          onDelete={() => deleteOcc(panel.occ)}
          onDuplicate={() => {
            setPanelError(null);
            setPanel({ kind: "editor", draft: { ...inputForOccurrence(panel.occ), recurringEventId: null, originalStart: null, exdates: [] }, occ: null });
          }}
        />
      )}
      {panel?.kind === "quick" && (
        <QuickCreate
          draft={panel.draft}
          anchor={panel.anchor}
          calendars={calendars}
          error={panelError}
          saving={data.saving}
          onChange={(draft) => setPanel({ ...panel, draft })}
          onSave={() => void saveDraft(panel.draft, null, false)}
          onMore={() => setPanel({ kind: "editor", draft: panel.draft, occ: null })}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === "editor" && (
        <EventEditor
          draft={panel.draft}
          isNew={!panel.occ}
          calendars={calendars}
          prefs={prefs}
          error={panelError}
          saving={data.saving}
          onChange={(draft) => setPanel({ ...panel, draft })}
          onSave={() => void saveDraft(panel.draft, panel.occ, true)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === "scope" && (
        <ScopeDialog
          action={panel.action}
          allowFollowing={!!panel.occ.master && eventStart(panel.occ.master).getTime() !== panel.occ.start.getTime()}
          allowThis={panel.action === "delete" || !panel.next || sameRule(panel.next.recurrence, panel.occ.master?.recurrence ?? null)}
          onPick={(s) => void applyScope(s)}
          onCancel={() => setPanel(panel.fromEditor && panel.next ? { kind: "editor", draft: panel.next, occ: panel.occ } : null)}
        />
      )}
      {panel?.kind === "day" && (
        <DayListPopover day={panel.day} anchor={panel.anchor} occurrences={occurrences} calendars={calMap} now={now} onOpen={openOcc} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === "settings" && (
        <SettingsDialog prefs={prefs} now={now} notifications={reminders.permission} onEnableNotifications={() => void reminders.request()} onSave={data.savePrefs} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === "shortcuts" && <ShortcutsDialog onClose={() => setPanel(null)} />}
      {panel?.kind === "goto" && <GoToDate onPick={(d) => pickDay(d)} onClose={() => setPanel(null)} />}

      <div className="pointer-events-none fixed bottom-4 left-4 z-[70] flex max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className={`cal-float cal-enter pointer-events-auto flex max-w-md items-center gap-4 rounded-lg border px-4 py-3 text-[13px] text-fg ${t.tone === "error" ? "border-status-hot/40 bg-bg-elev" : "border-hairline bg-bg-elev"}`}>
            <span className="min-w-0 flex-1">{t.text}</span>
            {t.undo && t.undo.length > 0 && (
              <button type="button" className="shrink-0 font-semibold text-accent hover:underline" onClick={() => void undo(t.undo!)}>
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function GoToDate({ onPick, onClose }: { onPick: (d: Date) => void; onClose: () => void }) {
  const [value, setValue] = useState(toDateKey(new Date()));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg-rail/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Go to date"
        className="cal-float cal-enter w-full max-w-xs rounded-lg border border-hairline bg-bg-elev p-4"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          if (isDateKey(value)) onPick(fromDateKey(value));
        }}
      >
        <label className="label" htmlFor="cal-goto">Go to date</label>
        <input id="cal-goto" type="date" autoFocus className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" data-variant="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" data-variant="primary">Go</button>
        </div>
      </form>
    </div>
  );
}
