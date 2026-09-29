"use client";

import { useRef } from "react";
import { AlignLeft, Bell, CalendarDays, Copy, MapPin, Pencil, Repeat2, Trash2, Users, X } from "lucide-react";
import { formatLongDate, formatShortDate, formatTime, formatTimeRange, sameDay } from "@/lib/calendar/dates";
import { describeRecurrence, eventStart } from "@/lib/calendar/recurrence";
import type { CalendarRecord, Occurrence } from "@/lib/calendar/types";
import { hueOf, placeBeside, reminderLabel, useDialogFocus, useOutsidePress, type Anchor } from "./ui";

type Props = {
  occ: Occurrence;
  anchor: Anchor | null;
  calendars: Map<string, CalendarRecord>;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

const W = 400;

export function whenText(occ: Occurrence): string {
  const lastDay = new Date(occ.end.getTime() - 1);
  if (occ.allDay) return sameDay(occ.start, lastDay) ? formatLongDate(occ.start) : `${formatShortDate(occ.start)} – ${formatShortDate(lastDay)}`;
  if (sameDay(occ.start, lastDay)) return `${formatLongDate(occ.start)} · ${formatTimeRange(occ.start, occ.end)}`;
  return `${formatShortDate(occ.start)}, ${formatTime(occ.start)} – ${formatShortDate(occ.end)}, ${formatTime(occ.end)}`;
}

export function EventPopover({ occ, anchor, calendars, onClose, onEdit, onDelete, onDuplicate }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  useOutsidePress(ref, onClose);
  const e = occ.event;
  const cal = calendars.get(e.calendarId);
  const rule = occ.master?.recurrence ?? e.recurrence;
  const pos = placeBeside(anchor, W, 320);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby="cal-pop-title"
      data-hue={hueOf(occ, calendars)}
      className="cal-float cal-enter fixed z-50 w-[min(400px,calc(100vw-32px))] rounded-lg border border-hairline bg-bg-elev"
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={(ev) => {
        const typing = (ev.target as HTMLElement).closest("input, textarea, select");
        if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
        if (ev.key === "e") {
          ev.preventDefault();
          onEdit();
        } else if (ev.key === "Delete" || ev.key === "Backspace") {
          ev.preventDefault();
          onDelete();
        }
      }}
    >
      <div className="flex items-center justify-end gap-0.5 px-2 pt-2">
        <button type="button" className="icon-btn" onClick={onEdit} aria-label="Edit event (E)" title="Edit (E)" data-autofocus>
          <Pencil className="h-4 w-4" />
        </button>
        <button type="button" className="icon-btn" onClick={onDuplicate} aria-label="Duplicate event" title="Duplicate">
          <Copy className="h-4 w-4" />
        </button>
        <button type="button" className="icon-btn hover:!text-status-hot" onClick={onDelete} aria-label="Delete event (Delete)" title="Delete (Del)">
          <Trash2 className="h-4 w-4" />
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto px-5 pb-5 pt-1">
        <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3">
          <span className="swatch mt-1.5 h-3.5 w-3.5 rounded" aria-hidden />
          <div>
            <h2 id="cal-pop-title" className="break-words text-lg font-semibold leading-snug text-fg">{e.title || "(No title)"}</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">{whenText(occ)}</p>
            {rule && <p className="text-[13px] text-fg-muted">{describeRecurrence(rule, eventStart(occ.master ?? e))}</p>}
          </div>
        </div>
        {e.location && (
          <Row icon={MapPin} label="Location">
            <span className="break-words">{e.location}</span>
          </Row>
        )}
        {e.guests.length > 0 && (
          <Row icon={Users} label="Guests">
            <span className="text-fg-muted">{e.guests.length} guest{e.guests.length === 1 ? "" : "s"}</span>
            <ul className="mt-1 space-y-0.5">
              {e.guests.map((g) => (
                <li key={g} className="truncate" title={g}>{g}</li>
              ))}
            </ul>
          </Row>
        )}
        {e.reminders.length > 0 && (
          <Row icon={Bell} label="Reminders">
            {e.reminders.map((m) => reminderLabel(m)).join(", ")}
          </Row>
        )}
        {e.description && (
          <Row icon={AlignLeft} label="Description">
            <p className="whitespace-pre-wrap break-words text-fg-muted">{e.description}</p>
          </Row>
        )}
        <Row icon={CalendarDays} label="Calendar">
          {cal?.name ?? "Calendar"}
          <span className="text-fg-dim"> · {e.busy ? "Busy" : "Free"}</span>
        </Row>
        {occ.master && (
          <p className="flex items-center gap-1.5 text-[11px] text-fg-dim">
            <Repeat2 className="h-3.5 w-3.5" aria-hidden /> Part of a repeating series
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, children }: { icon: typeof MapPin; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 text-[13px] text-fg">
      <Icon className="mt-0.5 h-4 w-4 text-fg-dim" aria-label={label} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
