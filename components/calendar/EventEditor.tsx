"use client";

import { useRef, useState } from "react";
import { AlignLeft, Bell, CalendarDays, Clock3, MapPin, Palette, Plus, Repeat2, Users, X } from "lucide-react";
import { addDays, addMinutes, fromDateKey, isDateKey, toDateKey } from "@/lib/calendar/dates";
import { CALENDAR_COLORS, CALENDAR_COLOR_LABELS, type CalendarPrefs, type CalendarRecord, type EventInput } from "@/lib/calendar/types";
import { RecurrenceField } from "./RecurrenceField";
import { REMINDER_CHOICES, inputEnd, inputStart, reminderLabel, useDialogFocus } from "./ui";

type Props = {
  draft: EventInput;
  isNew: boolean;
  calendars: CalendarRecord[];
  prefs: CalendarPrefs;
  error: string | null;
  saving: boolean;
  onChange: (d: EventInput) => void;
  onSave: () => void;
  onClose: () => void;
};

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[A-Za-z]{2,24}$/;

function timeValue(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function combine(dateKey: string, time: string): Date | null {
  if (!isDateKey(dateKey) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = fromDateKey(dateKey);
  const [h, m] = time.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export function EventEditor({ draft, isNew, calendars, prefs, error, saving, onChange, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  const [guest, setGuest] = useState("");
  const [guestError, setGuestError] = useState<string | null>(null);
  const start = inputStart(draft);
  const end = inputEnd(draft);
  // All-day ends are stored exclusive; people read and type them inclusive.
  const endShown = draft.allDay ? addDays(end, -1) : end;

  const setTimes = (s: Date, e: Date) =>
    onChange({
      ...draft,
      start: draft.allDay ? toDateKey(s) : s.toISOString(),
      end: draft.allDay ? toDateKey(e) : e.toISOString(),
    });

  const onStartDate = (key: string) => {
    const s = draft.allDay ? (isDateKey(key) ? fromDateKey(key) : null) : combine(key, timeValue(start));
    if (!s) return;
    // Moving the start keeps the duration, as Google does.
    setTimes(s, new Date(s.getTime() + (end.getTime() - start.getTime())));
  };
  const onStartTime = (t: string) => {
    const s = combine(toDateKey(start), t);
    if (s) setTimes(s, new Date(s.getTime() + (end.getTime() - start.getTime())));
  };
  const onEndDate = (key: string) => {
    if (!isDateKey(key)) return;
    const e = draft.allDay ? addDays(fromDateKey(key), 1) : combine(key, timeValue(end));
    if (e) setTimes(start, e);
  };
  const onEndTime = (t: string) => {
    const e = combine(toDateKey(end), t);
    if (e) setTimes(start, e);
  };
  const toggleAllDay = (allDay: boolean) => {
    if (allDay) {
      onChange({ ...draft, allDay, start: toDateKey(start), end: toDateKey(addDays(endShown, 1)), reminders: [] });
    } else {
      const s = new Date(start);
      s.setHours(9, 0, 0, 0);
      onChange({ ...draft, allDay, start: s.toISOString(), end: addMinutes(s, prefs.defaultDurationMin).toISOString(), reminders: [10] });
    }
  };

  const addGuest = () => {
    const g = guest.trim().toLowerCase();
    if (!g) return;
    if (!EMAIL.test(g)) return setGuestError("Enter a full email address.");
    if (draft.guests.includes(g)) return setGuestError("Already on the list.");
    if (draft.guests.length >= 50) return setGuestError("Up to 50 guests.");
    onChange({ ...draft, guests: [...draft.guests, g] });
    setGuest("");
    setGuestError(null);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg-rail/70 p-0 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? "New event" : "Edit event"}
        className="cal-float cal-enter flex h-full w-full flex-col border border-hairline bg-bg-elev sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:max-w-2xl sm:rounded-lg"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <div className="flex items-center gap-3 border-b border-hairline px-5 py-3">
            <button type="button" className="icon-btn -ml-2" onClick={onClose} aria-label="Close without saving">
              <X className="h-5 w-5" />
            </button>
            <input
              data-autofocus
              aria-label="Title"
              className="min-w-0 flex-1 border-b border-transparent bg-transparent py-1 text-xl font-medium text-fg outline-none placeholder:text-fg-dim focus:border-accent"
              placeholder="Add title"
              maxLength={300}
              value={draft.title}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
            />
            <button type="submit" className="btn" data-variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {error && (
              <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-[13px] text-fg">
                {error}
              </p>
            )}

            <Field icon={Clock3} label="When">
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" aria-label="Start date" className="input h-9 w-auto" value={toDateKey(start)} onChange={(e) => onStartDate(e.target.value)} />
                {!draft.allDay && <input type="time" step={900} aria-label="Start time" className="input h-9 w-auto" value={timeValue(start)} onChange={(e) => onStartTime(e.target.value)} />}
                <span className="text-fg-dim">to</span>
                {!draft.allDay && <input type="time" step={900} aria-label="End time" className="input h-9 w-auto" value={timeValue(end)} onChange={(e) => onEndTime(e.target.value)} />}
                <input type="date" aria-label="End date" className="input h-9 w-auto" value={toDateKey(endShown)} min={toDateKey(start)} onChange={(e) => onEndDate(e.target.value)} />
              </div>
              <label className="mt-2 inline-flex items-center gap-2 text-[13px] text-fg">
                <input type="checkbox" className="h-4 w-4" checked={draft.allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
                All day
              </label>
              <p className="mt-1 text-[11px] text-fg-dim">{draft.timeZone}</p>
            </Field>

            <Field icon={Repeat2} label="Repeat">
              <RecurrenceField value={draft.recurrence} start={start} onChange={(recurrence) => onChange({ ...draft, recurrence })} />
            </Field>

            <Field icon={MapPin} label="Location">
              <input className="input" placeholder="Add location" maxLength={500} value={draft.location} onChange={(e) => onChange({ ...draft, location: e.target.value })} />
            </Field>

            <Field icon={Users} label="Guests">
              <div className="flex gap-2">
                <input
                  className="input"
                  type="email"
                  placeholder="Add a guest by email"
                  value={guest}
                  onChange={(e) => {
                    setGuest(e.target.value);
                    setGuestError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addGuest();
                    }
                  }}
                  aria-describedby="cal-guest-note"
                />
                <button type="button" className="btn shrink-0" onClick={addGuest}>
                  <Plus className="h-4 w-4" /> Add
                </button>
              </div>
              {guestError && <p role="alert" className="mt-1 text-[12px] text-status-hot">{guestError}</p>}
              <p id="cal-guest-note" className="mt-1 text-[11px] text-fg-dim">Guests are recorded on the event. No invitation is sent.</p>
              {draft.guests.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {draft.guests.map((g) => (
                    <li key={g} className="inline-flex max-w-full items-center gap-1 rounded-full border border-hairline bg-bg-panel py-0.5 pl-2.5 pr-1 text-[12px] text-fg">
                      <span className="truncate" title={g}>{g}</span>
                      <button type="button" className="icon-btn h-5 w-5" aria-label={`Remove ${g}`} onClick={() => onChange({ ...draft, guests: draft.guests.filter((x) => x !== g) })}>
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field icon={Bell} label="Reminders">
              <div className="space-y-2">
                {draft.reminders.map((m, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      className="select h-9"
                      aria-label={`Reminder ${i + 1}`}
                      value={m}
                      onChange={(e) => onChange({ ...draft, reminders: draft.reminders.map((x, j) => (j === i ? Number(e.target.value) : x)) })}
                    >
                      {REMINDER_CHOICES.map((c) => (
                        <option key={c} value={c}>{reminderLabel(c)}</option>
                      ))}
                    </select>
                    <button type="button" className="icon-btn shrink-0" aria-label={`Remove reminder ${i + 1}`} onClick={() => onChange({ ...draft, reminders: draft.reminders.filter((_, j) => j !== i) })}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {draft.reminders.length < 5 && (
                  <button type="button" className="btn" data-variant="ghost" onClick={() => onChange({ ...draft, reminders: [...draft.reminders, 30] })}>
                    <Plus className="h-4 w-4" /> Add reminder
                  </button>
                )}
              </div>
            </Field>

            <Field icon={CalendarDays} label="Calendar">
              <div className="flex flex-wrap items-center gap-2">
                <select className="select h-9 w-auto" aria-label="Calendar" value={draft.calendarId} onChange={(e) => onChange({ ...draft, calendarId: e.target.value })}>
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <select className="select h-9 w-auto" aria-label="Show as" value={draft.busy ? "busy" : "free"} onChange={(e) => onChange({ ...draft, busy: e.target.value === "busy" })}>
                  <option value="busy">Busy</option>
                  <option value="free">Free</option>
                </select>
              </div>
            </Field>

            <Field icon={Palette} label="Colour">
              <div role="radiogroup" aria-label="Event colour" className="flex flex-wrap gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.color === null}
                  onClick={() => onChange({ ...draft, color: null })}
                  className={`h-7 rounded-full border px-2.5 text-[12px] ${draft.color === null ? "border-fg text-fg" : "border-hairline text-fg-muted hover:text-fg"}`}
                >
                  Calendar colour
                </button>
                {CALENDAR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === c}
                    aria-label={CALENDAR_COLOR_LABELS[c]}
                    title={CALENDAR_COLOR_LABELS[c]}
                    data-hue={c}
                    onClick={() => onChange({ ...draft, color: c })}
                    className={`swatch h-7 w-7 rounded-full outline-none ring-offset-2 ring-offset-bg-elev focus-visible:ring-2 focus-visible:ring-accent ${draft.color === c ? "ring-2 ring-fg" : ""}`}
                  />
                ))}
              </div>
            </Field>

            <Field icon={AlignLeft} label="Description">
              <textarea className="textarea" rows={4} maxLength={8000} placeholder="Add description" value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
            </Field>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ icon: Icon, label, children }: { icon: typeof MapPin; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-4">
      <Icon className="mt-2.5 h-4 w-4 text-fg-dim" aria-hidden />
      <div className="min-w-0">
        <span className="sr-only">{label}</span>
        {children}
      </div>
    </div>
  );
}
