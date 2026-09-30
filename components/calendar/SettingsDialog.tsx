"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import { formatTime } from "@/lib/calendar/dates";
import { shabbatForWeekOf } from "@/lib/calendar/sun";
import type { CalendarPrefs } from "@/lib/calendar/types";
import { useDialogFocus } from "./ui";

type Props = {
  prefs: CalendarPrefs;
  now: Date;
  notifications: NotificationPermission | "unsupported";
  onEnableNotifications: () => void;
  onSave: (p: CalendarPrefs) => Promise<void>;
  onClose: () => void;
};

const PLACES = [
  { label: "Montréal", lat: 45.5017, lon: -73.5673 },
  { label: "Toronto", lat: 43.6532, lon: -79.3832 },
  { label: "New York", lat: 40.7128, lon: -74.006 },
  { label: "Miami", lat: 25.7617, lon: -80.1918 },
  { label: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { label: "London", lat: 51.5072, lon: -0.1276 },
  { label: "Jerusalem", lat: 31.7683, lon: 35.2137 },
];

export function SettingsDialog({ prefs, now, notifications, onEnableNotifications, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  const [p, setP] = useState(prefs);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = shabbatForWeekOf(now, p);
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg-rail/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="cal-settings-h" className="cal-float cal-enter flex max-h-[calc(100dvh-32px)] w-full max-w-lg flex-col rounded-lg border border-hairline bg-bg-elev">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h2 id="cal-settings-h" className="text-base font-semibold text-fg">Calendar settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form
          className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 text-[13px] text-fg"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await onSave(p);
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Settings could not be saved.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset className="space-y-3">
            <legend className="mb-2 font-semibold">View</legend>
            <label className="flex items-center justify-between gap-4">
              Week starts on
              <select className="select h-8 w-auto py-0" value={p.weekStartsOn} onChange={(e) => setP({ ...p, weekStartsOn: Number(e.target.value) as 0 | 1 | 6 })}>
                <option value={0}>Sunday</option>
                <option value={1}>Monday</option>
                <option value={6}>Saturday</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-4">
              Show weekends
              <input type="checkbox" className="h-4 w-4" checked={p.showWeekends} onChange={(e) => setP({ ...p, showWeekends: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-4">
              Default event length
              <select className="select h-8 w-auto py-0" value={p.defaultDurationMin} onChange={(e) => setP({ ...p, defaultDurationMin: Number(e.target.value) })}>
                {[15, 30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>{m} minutes</option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-2 font-semibold">Sky and Shabbat</legend>
            <p className="text-fg-muted">Sunrise, sunset and Shabbat are computed for this place. Use your community&rsquo;s published times for the offsets.</p>
            <label className="flex items-center justify-between gap-4">
              Location
              <select
                className="select h-8 w-auto py-0"
                value={PLACES.find((x) => x.label === p.location.label) ? p.location.label : "custom"}
                onChange={(e) => {
                  const place = PLACES.find((x) => x.label === e.target.value);
                  if (place) setP({ ...p, location: place });
                }}
              >
                {PLACES.map((x) => (
                  <option key={x.label} value={x.label}>{x.label}</option>
                ))}
                {!PLACES.find((x) => x.label === p.location.label) && <option value="custom">{p.location.label}</option>}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className="label">Latitude</span>
                <input className="input h-8" type="number" step="0.0001" min={-90} max={90} value={p.location.lat} onChange={(e) => setP({ ...p, location: { label: "Custom", lat: Number(e.target.value), lon: p.location.lon } })} />
              </label>
              <label>
                <span className="label">Longitude</span>
                <input className="input h-8" type="number" step="0.0001" min={-180} max={180} value={p.location.lon} onChange={(e) => setP({ ...p, location: { label: "Custom", lat: p.location.lat, lon: Number(e.target.value) } })} />
              </label>
            </div>
            <label className="flex items-center justify-between gap-4">
              Protect Shabbat (no events can be booked)
              <input type="checkbox" className="h-4 w-4" checked={p.shabbatProtection} onChange={(e) => setP({ ...p, shabbatProtection: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-4">
              Candle lighting, minutes before sunset
              <input className="input h-8 w-20" type="number" min={0} max={120} value={p.candleMinutesBeforeSunset} onChange={(e) => setP({ ...p, candleMinutesBeforeSunset: num(e.target.value, 0, 120) })} />
            </label>
            <label className="flex items-center justify-between gap-4">
              Shabbat ends, minutes after sunset
              <input className="input h-8 w-20" type="number" min={0} max={120} value={p.havdalahMinutesAfterSunset} onChange={(e) => setP({ ...p, havdalahMinutesAfterSunset: num(e.target.value, 0, 120) })} />
            </label>
            <p className="rounded-md border border-hairline bg-bg-panel px-3 py-2 text-fg-muted">
              This week: candles Friday {formatTime(preview.start)}, ends Saturday {formatTime(preview.end)}.
            </p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-2 font-semibold">Reminders</legend>
            <p className="text-fg-muted">Reminders appear while this page is open. Desktop notifications also show them when the tab is in the background.</p>
            {notifications === "granted" ? (
              <p className="text-fg">Desktop notifications are on.</p>
            ) : notifications === "denied" ? (
              <p className="text-fg-muted">Desktop notifications are blocked in this browser&rsquo;s site settings.</p>
            ) : notifications === "unsupported" ? (
              <p className="text-fg-muted">This browser does not support desktop notifications.</p>
            ) : (
              <button type="button" className="btn" onClick={onEnableNotifications}>Turn on desktop notifications</button>
            )}
          </fieldset>

          {error && <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-fg">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-hairline pt-4">
            <button type="button" className="btn" data-variant="ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" data-variant="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
