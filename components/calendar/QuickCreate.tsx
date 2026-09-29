"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import { formatLongDate, formatShortDate, formatTimeRange, sameDay } from "@/lib/calendar/dates";
import type { CalendarRecord, EventInput } from "@/lib/calendar/types";
import { inputEnd, inputStart, placeBeside, useDialogFocus, useOutsidePress, type Anchor } from "./ui";

type Props = {
  draft: EventInput;
  anchor: Anchor | null;
  calendars: CalendarRecord[];
  error: string | null;
  saving: boolean;
  onChange: (d: EventInput) => void;
  onSave: () => void;
  onMore: () => void;
  onClose: () => void;
};

export function QuickCreate({ draft, anchor, calendars, error, saving, onChange, onSave, onMore, onClose }: Props) {
  const ref = useRef<HTMLFormElement>(null);
  useDialogFocus(ref, onClose);
  useOutsidePress(ref, onClose);
  const [touched, setTouched] = useState(false);
  const pos = placeBeside(anchor, 360, 260);
  const start = inputStart(draft);
  const end = inputEnd(draft);
  const lastDay = new Date(end.getTime() - 1);
  const when = draft.allDay
    ? sameDay(start, lastDay) ? formatLongDate(start) : `${formatShortDate(start)} – ${formatShortDate(lastDay)}`
    : `${formatLongDate(start)} · ${formatTimeRange(start, end)}`;
  const cal = calendars.find((c) => c.id === draft.calendarId);

  return (
    <form
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label="New event"
      className="cal-float cal-enter fixed z-50 w-[min(360px,calc(100vw-32px))] rounded-lg border border-hairline bg-bg-elev p-4"
      style={{ top: pos.top, left: pos.left }}
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        onSave();
      }}
    >
      <div className="flex items-start gap-2">
        <input
          data-autofocus
          aria-label="Title"
          className="w-full border-b border-hairline bg-transparent pb-1.5 text-lg font-medium text-fg outline-none placeholder:text-fg-dim focus:border-accent"
          placeholder="Add title"
          value={draft.title}
          maxLength={300}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
        <button type="button" className="icon-btn -mr-1 -mt-1 shrink-0" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-3 text-[13px] text-fg-muted">{when}</p>
      <label className="mt-3 flex items-center gap-2 text-[13px] text-fg-muted">
        <span className="shrink-0">Calendar</span>
        <span className="swatch h-2.5 w-2.5 shrink-0 rounded-full" data-hue={cal?.color} aria-hidden />
        <select
          className="select h-8 py-0 text-[13px]"
          value={draft.calendarId}
          onChange={(e) => onChange({ ...draft, calendarId: e.target.value })}
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      {error && touched && (
        <p role="alert" className="mt-3 rounded-md border border-status-hot/40 bg-status-hot/10 px-2.5 py-2 text-[12px] text-fg">
          {error}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" className="btn" data-variant="ghost" onClick={onMore}>
          More options
        </button>
        <button type="submit" className="btn" data-variant="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
