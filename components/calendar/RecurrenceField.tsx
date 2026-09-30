"use client";

import { useState } from "react";
import { addMonths, isDateKey, ordinal, toDateKey, weekdayLong, weekdayShort, monthLong } from "@/lib/calendar/dates";
import { describeRecurrence, nthWeekdayOf } from "@/lib/calendar/recurrence";
import type { Recurrence, RecurrenceFreq } from "@/lib/calendar/types";

type Props = { value: Recurrence | null; start: Date; onChange: (r: Recurrence | null) => void };

type Preset = { id: string; label: string; rule: Recurrence | null };

function presets(start: Date): Preset[] {
  const { n, last } = nthWeekdayOf(start);
  return [
    { id: "none", label: "Does not repeat", rule: null },
    { id: "daily", label: "Daily", rule: { freq: "DAILY", interval: 1 } },
    { id: "weekly", label: `Weekly on ${weekdayLong(start.getDay())}`, rule: { freq: "WEEKLY", interval: 1, byWeekday: [start.getDay()] } },
    { id: "monthly-nth", label: `Monthly on the ${last && n === 5 ? "last" : ordinal(n)} ${weekdayLong(start.getDay())}`, rule: { freq: "MONTHLY", interval: 1, monthlyMode: "nth" } },
    { id: "monthly-day", label: `Monthly on day ${start.getDate()}`, rule: { freq: "MONTHLY", interval: 1, monthlyMode: "day" } },
    { id: "yearly", label: `Annually on ${monthLong(start.getMonth())} ${start.getDate()}`, rule: { freq: "YEARLY", interval: 1 } },
    { id: "weekdays", label: "Every weekday (Monday to Friday)", rule: { freq: "WEEKLY", interval: 1, byWeekday: [1, 2, 3, 4, 5] } },
  ];
}

const same = (a: Recurrence | null, b: Recurrence | null) => JSON.stringify(normal(a)) === JSON.stringify(normal(b));
const normal = (r: Recurrence | null) =>
  r && { f: r.freq, i: r.interval, w: [...(r.byWeekday ?? [])].sort(), m: r.freq === "MONTHLY" ? r.monthlyMode ?? "day" : null, u: r.until ?? null, c: r.count ?? null };

export function RecurrenceField({ value, start, onChange }: Props) {
  const list = presets(start);
  const match = list.find((p) => same(p.rule, value));
  const [custom, setCustom] = useState(!match);
  const selectValue = custom ? "custom" : match?.id ?? "custom";

  return (
    <div className="space-y-3">
      <select
        className="select"
        aria-label="Repeat"
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setCustom(true);
            onChange(value ?? { freq: "WEEKLY", interval: 1, byWeekday: [start.getDay()] });
            return;
          }
          setCustom(false);
          onChange(list.find((p) => p.id === e.target.value)?.rule ?? null);
        }}
      >
        {list.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
        <option value="custom">{custom && value ? `Custom: ${describeRecurrence(value, start)}` : "Custom…"}</option>
      </select>
      {custom && value && <CustomRule value={value} start={start} onChange={onChange} />}
    </div>
  );
}

function CustomRule({ value, start, onChange }: { value: Recurrence; start: Date; onChange: (r: Recurrence) => void }) {
  const ends = value.until ? "on" : value.count ? "after" : "never";
  const set = (patch: Partial<Recurrence>) => onChange({ ...value, ...patch });
  const unit: Record<RecurrenceFreq, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
  return (
    <div className="space-y-4 rounded-md border border-hairline bg-bg-deep/60 p-3 text-[13px] text-fg">
      <div className="flex flex-wrap items-center gap-2">
        <span>Repeat every</span>
        <input
          type="number"
          min={1}
          max={99}
          aria-label="Interval"
          className="input h-8 w-16 py-0"
          value={value.interval}
          onChange={(e) => set({ interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
        />
        <select
          aria-label="Unit"
          className="select h-8 w-auto py-0"
          value={value.freq}
          onChange={(e) => {
            const freq = e.target.value as RecurrenceFreq;
            onChange({
              freq,
              interval: value.interval,
              until: value.until,
              count: value.count,
              ...(freq === "WEEKLY" ? { byWeekday: [start.getDay()] } : {}),
              ...(freq === "MONTHLY" ? { monthlyMode: "day" as const } : {}),
            });
          }}
        >
          {(Object.keys(unit) as RecurrenceFreq[]).map((f) => (
            <option key={f} value={f}>{unit[f]}{value.interval > 1 ? "s" : ""}</option>
          ))}
        </select>
      </div>

      {value.freq === "WEEKLY" && (
        <fieldset>
          <legend className="mb-2 text-fg-muted">Repeat on</legend>
          <div className="flex flex-wrap gap-1.5">
            {[0, 1, 2, 3, 4, 5, 6].map((d) => {
              const on = (value.byWeekday ?? [start.getDay()]).includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={weekdayLong(d)}
                  onClick={() => {
                    const cur = new Set(value.byWeekday ?? [start.getDay()]);
                    if (on) cur.delete(d);
                    else cur.add(d);
                    if (cur.size === 0) return; // at least one day
                    set({ byWeekday: [...cur].sort() });
                  }}
                  className={`h-8 w-8 rounded-full text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? "bg-accent-muted text-fg" : "bg-bg-panel text-fg-muted hover:text-fg"}`}
                >
                  {weekdayShort(d)[0]}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {value.freq === "MONTHLY" && (
        <select className="select h-8 py-0" aria-label="Monthly on" value={value.monthlyMode ?? "day"} onChange={(e) => set({ monthlyMode: e.target.value as "day" | "nth" })}>
          <option value="day">On day {start.getDate()}</option>
          <option value="nth">
            On the {nthWeekdayOf(start).last && nthWeekdayOf(start).n === 5 ? "last" : ordinal(nthWeekdayOf(start).n)} {weekdayLong(start.getDay())}
          </option>
        </select>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-1 text-fg-muted">Ends</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="cal-ends" checked={ends === "never"} onChange={() => onChange({ ...value, until: undefined, count: undefined })} />
          Never
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input type="radio" name="cal-ends" checked={ends === "on"} onChange={() => onChange({ ...value, count: undefined, until: toDateKey(addMonths(start, 3)) })} />
          On
          <input
            type="date"
            aria-label="End date"
            className="input h-8 w-auto py-0"
            disabled={ends !== "on"}
            value={value.until ?? ""}
            min={toDateKey(start)}
            onChange={(e) => isDateKey(e.target.value) && set({ until: e.target.value, count: undefined })}
          />
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input type="radio" name="cal-ends" checked={ends === "after"} onChange={() => onChange({ ...value, until: undefined, count: 10 })} />
          After
          <input
            type="number"
            min={1}
            max={999}
            aria-label="Number of occurrences"
            className="input h-8 w-20 py-0"
            disabled={ends !== "after"}
            value={value.count ?? 10}
            onChange={(e) => set({ count: Math.max(1, Math.min(999, Number(e.target.value) || 1)), until: undefined })}
          />
          occurrences
        </label>
      </fieldset>
    </div>
  );
}
