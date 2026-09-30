"use client";

/** Small shared helpers for the calendar UI. No React state lives here. */

import { useEffect, useRef, type RefObject } from "react";
import { addDays, addMinutes, fromDateKey, toDateKey } from "@/lib/calendar/dates";
import type { CalendarColor, CalendarPrefs, CalendarRecord, EventInput, Occurrence } from "@/lib/calendar/types";

export function hueOf(occ: Occurrence, calendars: Map<string, CalendarRecord>): CalendarColor {
  return occ.event.color ?? calendars.get(occ.event.calendarId)?.color ?? "slate";
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Toronto";
  } catch {
    return "America/Toronto";
  }
}

/** A blank event for a slot. `start`/`end` are local Dates; all-day uses dates. */
export function draftFor(
  start: Date,
  end: Date | null,
  allDay: boolean,
  calendarId: string,
  prefs: CalendarPrefs,
): EventInput {
  const finish = end ?? (allDay ? addDays(start, 1) : addMinutes(start, prefs.defaultDurationMin));
  return {
    calendarId,
    title: "",
    description: "",
    location: "",
    allDay,
    start: allDay ? toDateKey(start) : start.toISOString(),
    end: allDay ? toDateKey(finish) : finish.toISOString(),
    timeZone: localTimeZone(),
    recurrence: null,
    exdates: [],
    recurringEventId: null,
    originalStart: null,
    color: null,
    reminders: allDay ? [] : [10],
    guests: [],
    busy: true,
  };
}

/** The editable input for one occurrence: the event's fields at this instance's times. */
export function inputForOccurrence(occ: Occurrence): EventInput {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = occ.event;
  // The draft shows the series' rule, but never carries the series link: the
  // Occurrence already knows its master, and the planner writes the link back
  // for a "this event" edit. A draft holding both a rule and a link is a
  // contradiction the validator rightly refuses.
  const base = occ.master && occ.event.id !== occ.master.id ? { ...rest, recurrence: occ.master.recurrence } : rest;
  return {
    ...base,
    recurringEventId: null,
    originalStart: null,
    start: occ.allDay ? toDateKey(occ.start) : occ.start.toISOString(),
    end: occ.allDay ? toDateKey(occ.end) : occ.end.toISOString(),
  };
}

export function inputStart(e: Pick<EventInput, "allDay" | "start">): Date {
  return e.allDay ? fromDateKey(e.start) : new Date(e.start);
}
export function inputEnd(e: Pick<EventInput, "allDay" | "end">): Date {
  return e.allDay ? fromDateKey(e.end) : new Date(e.end);
}

export type Anchor = { top: number; left: number; right: number; bottom: number };

export function anchorOf(el: Element | null | undefined): Anchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
}

/** Places a floating panel beside an anchor, flipping and clamping to the viewport. */
export function placeBeside(anchor: Anchor | null, width: number, height: number): { top: number; left: number } {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const gap = 8;
  const margin = 16;
  if (!anchor || vw < 640) return { top: Math.max(margin, (vh - height) / 2), left: Math.max(margin, (vw - width) / 2) };
  let left = anchor.right + gap;
  if (left + width > vw - margin) left = anchor.left - gap - width;
  if (left < margin) left = Math.min(vw - width - margin, Math.max(margin, anchor.left));
  let top = anchor.top;
  if (top + height > vh - margin) top = vh - height - margin;
  return { top: Math.max(margin, top), left };
}

/** Keeps Tab inside `ref`, closes on Escape, restores focus on unmount. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [],
      );
    const frame = requestAnimationFrame(() => {
      const auto = node?.querySelector<HTMLElement>("[data-autofocus]");
      (auto ?? focusables()[0])?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node?.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      node?.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active]);
}

/** Closes a popover on an outside pointer press. */
export function useOutsidePress(ref: RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    // Registered on the next tick so the press that opened it does not close it.
    const t = setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [ref, active]);
}

export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 10080] as const;

export function reminderLabel(min: number): string {
  if (min === 0) return "At start time";
  if (min < 60) return `${min} minutes before`;
  if (min < 1440) return `${min / 60} hour${min === 60 ? "" : "s"} before`;
  if (min < 10080) return `${min / 1440} day${min === 1440 ? "" : "s"} before`;
  return `${min / 10080} week${min === 10080 ? "" : "s"} before`;
}

export function visibleCalendarIds(calendars: CalendarRecord[]): Set<string> {
  return new Set(calendars.filter((c) => c.visible).map((c) => c.id));
}
