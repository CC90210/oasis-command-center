"use client";

/**
 * The Schedule's "Booking link" card (CC, 2026-10-16): the public link
 * prospects book through (oasisai.work/book), whether it is live, where the
 * signed-in person's booked calls land, and the hours each host takes calls.
 *
 * Reads and saves through /api/calendar/booking. Drawn only for the workspace
 * whose public booking runs (the API answers available:false elsewhere).
 * ASCII only.
 */

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Copy, ExternalLink, Settings2, X } from "lucide-react";
import type { BookingSettings, WeeklyHours } from "@/lib/booking/hours";
import { setupHref } from "@/lib/setup-links";

type BookingInfo = {
  ok: true;
  available: true;
  path: string;
  live: boolean;
  version: number;
  saved: boolean;
  settings: BookingSettings;
  canEdit: boolean;
  you: string;
  hosts: {
    userId: string;
    name: string;
    role: "organizer" | "attendee";
    calendar: { ready: boolean; label: string };
  }[];
  calendars: { id: string; name: string; isDefault: boolean }[];
};

type Load =
  | { status: "loading" }
  | { status: "hidden" }
  | { status: "error"; message: string }
  | { status: "ready"; info: BookingInfo };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmm(minute: number): string {
  const m = Math.min(Math.max(minute, 0), 24 * 60 - 1);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function toMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clock(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

/** "Sun-Thu 10am-9pm" style summary; days with different hours are listed apart. */
function summarize(week: WeeklyHours): string {
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    const w = week[i][0];
    if (!w) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && week[j + 1][0] && week[j + 1][0].start === w.start && week[j + 1][0].end === w.end) j += 1;
    parts.push(`${i === j ? DAY_SHORT[i] : `${DAY_SHORT[i]}-${DAY_SHORT[j]}`} ${clock(w.start)}-${clock(w.end)}`);
    i = j + 1;
  }
  return parts.length ? parts.join(", ") : "No hours";
}

export function BookingLinkCard() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/booking", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as (BookingInfo | { ok: true; available: false } | { ok: false; error?: string }) | null;
      if (!data || !data.ok) {
        setLoad({ status: "error", message: "Booking settings could not load." });
        return;
      }
      if (!("available" in data) || !data.available) {
        setLoad({ status: "hidden" });
        return;
      }
      setLoad({ status: "ready", info: data });
    } catch {
      setLoad({ status: "error", message: "Booking settings could not load." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (load.status === "hidden" || load.status === "loading") return null;
  if (load.status === "error") {
    return (
      <section className="rounded-lg border border-hairline bg-bg-panel p-3 text-[12px] text-fg-muted">
        <p>{load.message}</p>
        <button type="button" className="btn mt-2 h-8 text-[12px]" onClick={() => void refresh()}>
          Try again
        </button>
      </section>
    );
  }

  const { info } = load;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}${info.path}`;
  const mine = info.settings.hosts.find((h) => h.userId === info.you);
  const landsOn = mine
    ? info.calendars.find((c) => c.id === mine.targetCalendarId)?.name ??
      info.calendars.find((c) => c.isDefault)?.name ??
      "Main calendar"
    : null;

  return (
    <section aria-labelledby="cal-booking-h" className="rounded-lg border border-hairline bg-bg-panel p-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <h3 id="cal-booking-h" className="flex items-center gap-1.5 font-semibold text-fg">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Booking link
        </h3>
        <span className={info.live ? "text-status-engaged" : "text-status-warm"}>{info.live ? "Live" : "Not live"}</span>
      </div>
      <p className="mt-2 truncate font-mono text-[11px] text-fg" title={url}>
        {url.replace(/^https?:\/\//, "")}
      </p>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          className="btn h-7 px-2 text-[12px]"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? "Copied" : "Copy"}
        </button>
        <a className="btn h-7 px-2 text-[12px]" href={info.path} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
        </a>
        {info.canEdit ? (
          <button type="button" className="btn h-7 px-2 text-[12px]" onClick={() => setEditing(true)}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Settings
          </button>
        ) : null}
      </div>
      {!info.live ? (
        <p className="mt-2 text-fg-muted">The &quot;Book a call&quot; form is not set up yet, so the link shows a fallback page.</p>
      ) : null}
      {landsOn ? (
        <p className="mt-2 text-fg-muted">
          Your booked calls land on <span className="text-fg">{landsOn}</span>.
        </p>
      ) : null}
      <ul className="mt-2 space-y-1.5 text-fg-muted">
        {info.hosts.map((host) => {
          const hours = info.settings.hosts.find((h) => h.userId === host.userId)?.weeklyHours;
          const you = host.userId === info.you;
          return (
            <li key={host.userId}>
              <span className="text-fg">{you ? "You" : host.name}</span>
              {host.role === "organizer" ? " (hosts)" : " (joins)"}: {hours ? summarize(hours) : "No hours"}
              {host.calendar.ready ? null : (
                <span className="block text-status-warm">
                  Google Calendar: {host.calendar.label}.{" "}
                  {host.role === "organizer"
                    ? "No times can be offered until it is connected."
                    : "Times that need them are closed until it is connected."}{" "}
                  {you ? (
                    <a className="underline underline-offset-2 hover:text-fg" href={setupHref("connector:google-workspace")}>
                      Connect it
                    </a>
                  ) : (
                    "They connect it in Settings, Connections."
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {editing ? (
        <BookingSettingsDialog
          info={info}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      ) : null}
    </section>
  );
}

type DayDraft = { on: boolean; start: string; end: string };

function draftWeek(week: WeeklyHours): DayDraft[] {
  return week.map((day) =>
    day[0] ? { on: true, start: hhmm(day[0].start), end: hhmm(day[0].end) } : { on: false, start: "10:00", end: "21:00" },
  );
}

function BookingSettingsDialog({
  info,
  onClose,
  onSaved,
}: {
  info: BookingInfo;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const s = info.settings;
  const [weeks, setWeeks] = useState<Record<string, DayDraft[]>>(() =>
    Object.fromEntries(s.hosts.map((h) => [h.userId, draftWeek(h.weeklyHours)])),
  );
  const mine = s.hosts.find((h) => h.userId === info.you);
  const [target, setTarget] = useState<string>(mine?.targetCalendarId ?? "");
  const [notice, setNotice] = useState(String(s.minNoticeMinutes / 60));
  const [ahead, setAhead] = useState(String(s.maxDaysAhead));
  const [buffer, setBuffer] = useState(String(s.bufferMinutes));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => (id === info.you ? "You" : info.hosts.find((h) => h.userId === id)?.name ?? "Teammate");

  const setDay = (userId: string, index: number, patch: Partial<DayDraft>) =>
    setWeeks((all) => ({ ...all, [userId]: all[userId].map((d, i) => (i === index ? { ...d, ...patch } : d)) }));

  const save = async () => {
    setError(null);
    const hosts = [];
    for (const host of s.hosts) {
      const week: WeeklyHours = [];
      for (const [i, d] of weeks[host.userId].entries()) {
        if (!d.on) {
          week.push([]);
          continue;
        }
        const start = toMinute(d.start);
        const end = toMinute(d.end);
        if (start === null || end === null || end <= start) {
          setError(`${nameOf(host.userId)}, ${DAY_NAMES[i]}: the end time must be after the start time.`);
          return;
        }
        week.push([{ start, end }]);
      }
      hosts.push({
        ...host,
        weeklyHours: week,
        targetCalendarId: host.userId === info.you ? (target || null) : host.targetCalendarId,
      });
    }
    const settings: BookingSettings = {
      ...s,
      minNoticeMinutes: Math.round(Number(notice) * 60),
      maxDaysAhead: Number(ahead),
      bufferMinutes: Number(buffer),
      hosts,
    };
    setBusy(true);
    try {
      const res = await fetch("/api/calendar/booking", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings, expectedVersion: info.version }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (data?.ok) {
        await onSaved();
        return;
      }
      setError(
        data?.error === "version_conflict"
          ? "Someone else saved these settings a moment ago. Close this and open it again to see their changes."
          : data?.error === "invalid_settings"
            ? "Some of these values are out of range. Check the hours and try again."
            : "Could not save. Try again.",
      );
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="booking-settings-h"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="cal-float max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-hairline bg-bg-elev p-5 text-[13px]">
        <div className="flex items-center justify-between">
          <h2 id="booking-settings-h" className="text-[15px] font-semibold text-fg">Booking settings</h2>
          <button type="button" className="icon-btn h-8 w-8" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-fg-muted">
          Times are {s.timeZone.replace("_", " ")}. A time is offered only when everyone on duty is free. Your weekly
          routine never blocks a booking; anything else on your Schedule or Google Calendar does.
        </p>

        <label className="mt-4 block font-medium text-fg" htmlFor="booking-target">
          Your booked calls land on
        </label>
        <select id="booking-target" className="input mt-1 h-9" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Main calendar</option>
          {info.calendars
            .filter((c) => !c.isDefault)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>

        {s.hosts.map((host) => (
          <fieldset key={host.userId} className="mt-5">
            <legend className="font-medium text-fg">
              {nameOf(host.userId)} {host.role === "organizer" ? "(hosts every call)" : "(joins when on duty)"}
            </legend>
            <div className="mt-2 space-y-1.5">
              {weeks[host.userId].map((d, i) => (
                <div key={DAY_NAMES[i]} className="grid grid-cols-[6.5rem_1fr_auto_1fr] items-center gap-2">
                  <label className="flex items-center gap-2 text-fg">
                    <input type="checkbox" checked={d.on} onChange={(e) => setDay(host.userId, i, { on: e.target.checked })} />
                    {DAY_SHORT[i]}
                  </label>
                  <input
                    type="time"
                    step={900}
                    className="input h-8"
                    aria-label={`${nameOf(host.userId)} ${DAY_NAMES[i]} start`}
                    disabled={!d.on}
                    value={d.start}
                    onChange={(e) => setDay(host.userId, i, { start: e.target.value })}
                  />
                  <span className="text-fg-dim">to</span>
                  <input
                    type="time"
                    step={900}
                    className="input h-8"
                    aria-label={`${nameOf(host.userId)} ${DAY_NAMES[i]} end`}
                    disabled={!d.on}
                    value={d.end}
                    onChange={(e) => setDay(host.userId, i, { end: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        ))}

        <div className="mt-5 grid grid-cols-3 gap-3">
          <label className="block text-fg">
            <span className="font-medium">Notice</span>
            <select className="input mt-1 h-9" value={notice} onChange={(e) => setNotice(e.target.value)}>
              {["0", "1", "2", "4", "12", "24", "48"].map((h) => (
                <option key={h} value={h}>
                  {h === "0" ? "None" : `${h} h`}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-fg">
            <span className="font-medium">Book ahead</span>
            <select className="input mt-1 h-9" value={ahead} onChange={(e) => setAhead(e.target.value)}>
              {["7", "14", "21", "30"].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <label className="block text-fg">
            <span className="font-medium">Gap</span>
            <select className="input mt-1 h-9" value={buffer} onChange={(e) => setBuffer(e.target.value)}>
              {["0", "5", "10", "15", "30"].map((m) => (
                <option key={m} value={m}>
                  {m === "0" ? "None" : `${m} min`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? <p role="alert" className="mt-4 text-status-hot">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn h-9" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn h-9" data-variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
