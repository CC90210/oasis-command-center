"use client";

/**
 * "Restore my weekly routine": the card an OASIS member sees on an empty
 * calendar. It lists every block and time the restore will write, lets the
 * times be edited first, and asks once more before writing. The preview is
 * the same planner the server runs (lib/calendar/routine.ts), with the
 * viewer's own Shabbat settings, so the Friday note says exactly what will be
 * shortened. The server recomputes everything on POST; nothing here is trusted
 * beyond the edited times, which it re-validates.
 */

import { useMemo, useState } from "react";
import { formatTimeRange, fromDateKey, monthShort } from "@/lib/calendar/dates";
import {
  applyRoutineTimes,
  buildRoutineSeries,
  MIN_SHORTENED_MIN,
  weekdaysLabel,
  type RoutineAdjustment,
  type RoutineBlock,
  type RoutineTimeEdit,
} from "@/lib/calendar/routine";
import type { CalendarPrefs, EventRecord } from "@/lib/calendar/types";
import { messageFor } from "./useCalendarData";

export type RoutineInfo = {
  available: true;
  restored: boolean;
  timeZone: string;
  windDownMinutes: number;
  blocks: RoutineBlock[];
};

export type RoutineRestored = {
  status: "restored";
  created: EventRecord[];
  adjusted: RoutineAdjustment[];
  dropped: string[];
};

type Props = {
  info: RoutineInfo;
  prefs: CalendarPrefs;
  calendarName: string;
  now: Date;
  onRestored: (result: RoutineRestored | { status: "already_restored" }) => void;
  onDismiss: () => void;
};

const at = (minute: number) => new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);
/** "HH:MM" for a time input; midnight at the END of a day shows as 00:00 and is read back as 24:00. */
const hhmm = (minute: number) => {
  const m = minute % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
function minutesOf(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]) * 60 + Number(m[2]);
  return n >= 0 && n <= 24 * 60 ? n : null;
}
function dateLabel(key: string): string {
  const d = fromDateKey(key);
  return `${monthShort(d.getMonth())} ${d.getDate()}, ${d.getFullYear()}`;
}

export function RoutineRestore({ info, prefs, calendarName, now, onRestored, onDismiss }: Props) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [times, setTimes] = useState<Record<string, { start: string; end: string }>>(() =>
    Object.fromEntries(info.blocks.map((b) => [b.key, { start: hhmm(b.startMinute), end: hhmm(b.endMinute) }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The edited times, validated the way the server validates them.
  const edits = useMemo<RoutineTimeEdit[] | null>(() => {
    const out: RoutineTimeEdit[] = [];
    for (const b of info.blocks) {
      const t = times[b.key];
      const startMinute = t ? minutesOf(t.start) : null;
      const endMinute = t ? minutesOf(t.end === "00:00" ? "24:00" : t.end) : null;
      if (startMinute === null || endMinute === null) return null;
      if (startMinute !== b.startMinute || endMinute !== b.endMinute) out.push({ key: b.key, startMinute, endMinute });
    }
    return out;
  }, [info.blocks, times]);
  const blocks = useMemo(() => {
    const applied = edits ? applyRoutineTimes(info.blocks, edits) : null;
    return applied && applied.ok ? applied.value : null;
  }, [info.blocks, edits]);
  const plan = useMemo(
    () => (blocks ? buildRoutineSeries(blocks, { calendarId: "preview", prefs, from: now, timeZone: info.timeZone }) : null),
    // The plan only moves with the week, not with every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, prefs, info.timeZone, now.toDateString()],
  );

  const restore = async () => {
    if (!edits) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/routine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(edits.length ? { times: edits } : {}),
      });
      const body = (await res.json().catch(() => null)) as
        | ({ ok: true } & (RoutineRestored | { status: "already_restored" }))
        | { ok: false; error?: string; detail?: string }
        | null;
      if (!res.ok || !body || !body.ok) {
        const failed = body && !body.ok ? body : null;
        setError(messageFor(failed?.error ?? "", failed?.detail));
        setMode("view");
        return;
      }
      onRestored(body);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setMode("view");
    } finally {
      setBusy(false);
    }
  };

  const shown = blocks ?? info.blocks;
  const adjusted = plan?.adjusted ?? [];

  return (
    <section aria-labelledby="routine-h" className="max-h-[55vh] shrink-0 overflow-y-auto border-b border-hairline bg-bg-panel px-4 py-4 md:px-6">
      <div className="max-w-3xl">
        <h2 id="routine-h" className="text-[15px] font-semibold text-fg">Restore my weekly routine</h2>
        <p className="mt-1 text-[13px] text-fg-muted">
          The old Schedule page showed these blocks every week. Restoring adds them to {calendarName} as repeating events in
          Montr&eacute;al time, so they show on every device you sign in from.
        </p>

        <ul className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2" aria-label="Blocks to restore">
          {shown.map((b) => (
            <li key={b.key} className="flex min-w-0 items-center gap-3 py-0.5 text-[13px]">
              {mode === "edit" ? (
                <span className="flex shrink-0 items-center gap-1">
                  <input
                    type="time"
                    step={300}
                    className="input h-7 w-[6.5rem] px-2 py-0 text-[12px]"
                    aria-label={`${b.title} starts`}
                    value={times[b.key]?.start ?? ""}
                    onChange={(e) => setTimes((t) => ({ ...t, [b.key]: { ...t[b.key], start: e.target.value } }))}
                  />
                  <span className="text-fg-dim" aria-hidden>
                    to
                  </span>
                  <input
                    type="time"
                    step={300}
                    className="input h-7 w-[6.5rem] px-2 py-0 text-[12px]"
                    aria-label={`${b.title} ends`}
                    value={times[b.key]?.end ?? ""}
                    onChange={(e) => setTimes((t) => ({ ...t, [b.key]: { ...t[b.key], end: e.target.value } }))}
                  />
                </span>
              ) : (
                <span className="w-28 shrink-0 tabular-nums text-fg-muted">{formatTimeRange(at(b.startMinute), at(b.endMinute))}</span>
              )}
              <span className="min-w-0 truncate text-fg">{b.title}</span>
              <span className="ml-auto shrink-0 text-[12px] text-fg-dim">{weekdaysLabel(b.weekdays)}</span>
            </li>
          ))}
        </ul>

        {mode === "edit" && !blocks && (
          <p role="alert" className="mt-2 text-[12px] text-status-hot">
            Each block has to end after it starts.
          </p>
        )}

        {prefs.shabbatProtection && adjusted.length > 0 && (
          <div className="mt-3 text-[12px] text-fg-muted">
            <p>
              Fridays near Shabbat: a block that would end less than {info.windDownMinutes} minutes before candle-lighting is
              shortened to end then, or left out that week if under {MIN_SHORTENED_MIN} minutes would remain.
            </p>
            <ul className="mt-1 space-y-0.5">
              {adjusted.map((a) => (
                <li key={a.key}>
                  {a.label}: shortened on {a.shortened} Friday{a.shortened === 1 ? "" : "s"}
                  {a.skipped ? `, left out on ${a.skipped}` : ""}, planned week by week through {dateLabel(a.through)}.
                </li>
              ))}
            </ul>
          </div>
        )}
        {plan && plan.dropped.length > 0 && (
          <p className="mt-2 text-[12px] text-status-warm">Not restored, every week falls inside Shabbat: {plan.dropped.join(", ")}.</p>
        )}

        {error && (
          <p role="alert" className="mt-3 rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-[13px] text-fg">
            {error}
          </p>
        )}

        {/* Kept in view while the list scrolls inside the card on a phone. */}
        <div className="sticky bottom-0 -mb-4 mt-2 flex flex-wrap items-center gap-2 bg-bg-panel pb-4 pt-2">
          {mode === "confirm" && plan ? (
            <>
              <p className="w-full text-[13px] text-fg">
                This adds {plan.series.length} repeating event{plan.series.length === 1 ? "" : "s"}
                {plan.singles.length ? ` and ${plan.singles.length} shortened Friday event${plan.singles.length === 1 ? "" : "s"}` : ""} to{" "}
                {calendarName}.
              </p>
              <button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void restore()}>
                {busy ? "Restoring…" : "Add them"}
              </button>
              <button type="button" className="btn" data-variant="ghost" disabled={busy} onClick={() => setMode("view")}>
                Back
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" data-variant="primary" disabled={!plan} onClick={() => setMode("confirm")}>
                {edits && edits.length ? "Restore with these times" : "Restore"}
              </button>
              {mode === "edit" ? (
                <button
                  type="button"
                  className="btn"
                  data-variant="ghost"
                  onClick={() => {
                    setTimes(Object.fromEntries(info.blocks.map((b) => [b.key, { start: hhmm(b.startMinute), end: hhmm(b.endMinute) }])));
                    setMode("view");
                  }}
                >
                  Reset times
                </button>
              ) : (
                <button type="button" className="btn" data-variant="ghost" onClick={() => setMode("edit")}>
                  Edit times
                </button>
              )}
              <button type="button" className="btn" data-variant="ghost" onClick={onDismiss}>
                Not now
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
