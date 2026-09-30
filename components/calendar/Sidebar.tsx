"use client";

import { useState } from "react";
import { Check, MoreHorizontal, Plus, Sunrise, Sunset } from "lucide-react";
import { formatTime, startOfDay, weekdayShort } from "@/lib/calendar/dates";
import { shabbatForWeekOf, sunTimes } from "@/lib/calendar/sun";
import { CALENDAR_COLORS, CALENDAR_COLOR_LABELS, type CalendarColor, type CalendarPrefs, type CalendarRecord } from "@/lib/calendar/types";
import { MiniMonth } from "./MiniMonth";

type Props = {
  cursor: Date;
  now: Date;
  prefs: CalendarPrefs;
  calendars: CalendarRecord[];
  busyDays: Set<number>;
  rangeStart: Date;
  rangeEnd: Date;
  legacyAvailable: boolean;
  onCreate: () => void;
  onPick: (d: Date) => void;
  onToggle: (c: CalendarRecord) => void;
  onAddCalendar: (name: string, color: CalendarColor) => Promise<void>;
  onEditCalendar: (c: CalendarRecord, patch: { name?: string; color?: CalendarColor }) => Promise<void>;
  onDeleteCalendar: (c: CalendarRecord) => void;
  onImportLegacy: () => void;
  onOpenSettings: () => void;
};

export function Sidebar(p: Props) {
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const place = p.prefs.location;
  const today = place ? sunTimes(p.now, place.lat, place.lon) : null;
  // The next Shabbat, or the one in progress.
  const shabbat = shabbatForWeekOf(p.now, p.prefs);
  const shabbatNow = p.now >= shabbat.start && p.now < shabbat.end;
  const upcoming = p.now < shabbat.end ? shabbat : shabbatForWeekOf(new Date(startOfDay(p.now).getTime() + 7 * 86_400_000), p.prefs);

  return (
    <nav aria-label="Calendar navigation" className="flex h-full w-full flex-col gap-6 overflow-y-auto px-3 pb-6 pt-3">
      <button type="button" className="btn h-10 self-start rounded-lg pl-3 pr-4" data-variant="primary" onClick={p.onCreate}>
        <Plus className="h-4 w-4" /> Create
      </button>

      <MiniMonth
        selected={p.cursor}
        now={p.now}
        weekStartsOn={p.prefs.weekStartsOn}
        busyDays={p.busyDays}
        rangeStart={p.rangeStart}
        rangeEnd={p.rangeEnd}
        onPick={p.onPick}
      />

      {!place || !today ? (
        <section aria-labelledby="cal-sky-h" className="rounded-lg border border-hairline bg-bg-panel p-3 text-[12px]">
          <h3 id="cal-sky-h" className="mb-1 font-semibold text-fg">No location set</h3>
          <p className="text-fg-muted">Pick a place to see sunrise and sunset here.</p>
          <button type="button" className="btn mt-2 h-8 text-[12px]" onClick={p.onOpenSettings}>
            Choose a location
          </button>
        </section>
      ) : (
      <section aria-labelledby="cal-sky-h" className="rounded-lg border border-hairline bg-bg-panel p-3 text-[12px]">
        <h3 id="cal-sky-h" className="mb-2 font-semibold text-fg">{place.label}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-fg-muted">
          <dt><Sunrise className="h-3.5 w-3.5" aria-label="Sunrise" /></dt>
          <dd>{today.sunrise ? formatTime(today.sunrise) : "No sunrise today"}</dd>
          <dt><Sunset className="h-3.5 w-3.5" aria-label="Sunset" /></dt>
          <dd>{today.sunset ? formatTime(today.sunset) : "No sunset today"}</dd>
          {p.prefs.shabbatProtection && (
            <>
              <dt><span className="protected-mark align-middle" aria-hidden /></dt>
              <dd className="text-fg">
                {shabbatNow ? (
                  <>Shabbat until {formatTime(upcoming.end)}</>
                ) : (
                  <>
                    Candles {weekdayShort(upcoming.start.getDay())} {formatTime(upcoming.start)}
                    <span className="text-fg-muted"> · ends {formatTime(upcoming.end)}</span>
                  </>
                )}
              </dd>
            </>
          )}
        </dl>
        {!upcoming.computed && <p className="mt-2 text-[11px] text-fg-dim">No sunset here this week; a wide protected window is used.</p>}
      </section>
      )}

      <section aria-labelledby="cal-list-h">
        <div className="mb-1 flex items-center justify-between pl-1">
          <h3 id="cal-list-h" className="text-[13px] font-semibold text-fg">My calendars</h3>
          <button type="button" className="icon-btn h-7 w-7" aria-label="Add calendar" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <ul className="space-y-0.5">
          {p.calendars.map((c) => (
            <li key={c.id} className="group relative" data-hue={c.color}>
              <div className="flex items-center rounded-md hover:bg-bg-hover">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 py-1.5 text-[13px] text-fg">
                  <input type="checkbox" className="peer sr-only" checked={c.visible} onChange={() => p.onToggle(c)} />
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${c.visible ? "swatch border-transparent" : "border-[color:var(--ev)] bg-transparent"}`}
                    aria-hidden
                  >
                    {c.visible && <Check className="h-3 w-3 text-bg" strokeWidth={3} />}
                  </span>
                  <span className="truncate" title={c.name}>{c.name}</span>
                </label>
                <button
                  type="button"
                  className="icon-btn h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Options for ${c.name}`}
                  aria-expanded={menuFor === c.id}
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
              {menuFor === c.id && (
                <CalendarMenu
                  cal={c}
                  onClose={() => setMenuFor(null)}
                  onSave={async (patch) => {
                    await p.onEditCalendar(c, patch);
                    setMenuFor(null);
                  }}
                  onDelete={() => {
                    setMenuFor(null);
                    p.onDeleteCalendar(c);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        {adding && (
          <NewCalendar
            onCancel={() => setAdding(false)}
            onSave={async (name, color) => {
              await p.onAddCalendar(name, color);
              setAdding(false);
            }}
          />
        )}
      </section>

      {p.legacyAvailable && (
        <section className="rounded-lg border border-dashed border-hairline p-3 text-[12px] text-fg-muted">
          <p>Your old weekly routine is still saved in this browser.</p>
          <button type="button" className="btn mt-2 h-8 text-[12px]" onClick={p.onImportLegacy}>
            Bring it into the calendar
          </button>
        </section>
      )}
    </nav>
  );
}

function ColorPicker({ value, onChange }: { value: CalendarColor; onChange: (c: CalendarColor) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour" className="grid grid-cols-5 gap-1.5">
      {CALENDAR_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={CALENDAR_COLOR_LABELS[c]}
          title={CALENDAR_COLOR_LABELS[c]}
          data-hue={c}
          onClick={() => onChange(c)}
          className={`swatch h-6 w-6 rounded-full outline-none ring-offset-2 ring-offset-bg-elev focus-visible:ring-2 focus-visible:ring-accent ${value === c ? "ring-2 ring-fg" : ""}`}
        />
      ))}
    </div>
  );
}

function NewCalendar({ onSave, onCancel }: { onSave: (name: string, color: CalendarColor) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<CalendarColor>("moss");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-hairline bg-bg-panel p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setError("Give the calendar a name.");
        setBusy(true);
        try {
          await onSave(name.trim(), color);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not create the calendar.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className="input h-8" autoFocus aria-label="Calendar name" placeholder="Calendar name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <ColorPicker value={color} onChange={setColor} />
      {error && <p role="alert" className="text-[12px] text-status-hot">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn h-8" data-variant="ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn h-8" data-variant="primary" disabled={busy}>{busy ? "Adding…" : "Add"}</button>
      </div>
    </form>
  );
}

function CalendarMenu({ cal, onSave, onDelete, onClose }: { cal: CalendarRecord; onSave: (p: { name?: string; color?: CalendarColor }) => Promise<void>; onDelete: () => void; onClose: () => void }) {
  const [name, setName] = useState(cal.name);
  const [color, setColor] = useState(cal.color);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="cal-float cal-enter absolute left-0 right-0 top-full z-30 mt-1 space-y-2 rounded-lg border border-hairline bg-bg-elev p-3"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave({ name: name.trim() || cal.name, color });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save.");
        }
      }}
    >
      <input className="input h-8" autoFocus aria-label="Calendar name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <ColorPicker value={color} onChange={setColor} />
      {error && <p role="alert" className="text-[12px] text-status-hot">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        {!cal.isDefault ? (
          <button type="button" className="btn h-8" data-variant="danger" onClick={onDelete}>Delete</button>
        ) : (
          <span className="text-[11px] text-fg-dim">Main calendar</span>
        )}
        <div className="flex gap-2">
          <button type="button" className="btn h-8" data-variant="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn h-8" data-variant="primary">Save</button>
        </div>
      </div>
    </form>
  );
}
