/**
 * One-time import of the old browser-only weekly schedule (lib/schedule/model.ts)
 * into real, repeating calendar events.
 *
 * The old page saved a template week per browser under `oasis.schedule.*`.
 * Each editable block becomes a weekly series on its weekday, starting the
 * week it was saved. System Shabbat blocks are skipped: Shabbat is now
 * computed from the sunset, not stored. A "Work" container whose children
 * were shown instead of it is skipped the same way the old page hid it.
 */

import { DAYS, isScheduleDocument, type ScheduleBlock, type ScheduleDocument } from "@/lib/schedule/model";
import { addDays, atMinute, fromDateKey, isDateKey } from "./dates";
import type { CalendarColor, CalendarPrefs, EventInput } from "./types";
import { shabbatConflict } from "./validate";

export const LEGACY_KEY_PREFIX = "oasis.schedule";

const HUE: Record<ScheduleBlock["category"], CalendarColor> = {
  morning: "saffron",
  work: "tide",
  personal: "moss",
  observance: "sand",
};

/** The most recently saved week among the raw localStorage values given. */
export function pickLegacyWeek(raw: (string | null)[]): ScheduleDocument | null {
  let best: ScheduleDocument | null = null;
  for (const text of raw) {
    if (!text) continue;
    try {
      const doc: unknown = JSON.parse(text);
      if (!isScheduleDocument(doc) || !isDateKey(doc.weekStartsOn)) continue;
      if (!best || doc.updatedAt > best.updatedAt) best = doc;
    } catch {
      /* A corrupt entry is skipped, never fatal. */
    }
  }
  return best;
}

export type LegacyPlan = { events: EventInput[]; skippedForShabbat: string[] };

export function planLegacyImport(doc: ScheduleDocument, calendarId: string, timeZone: string, prefs: CalendarPrefs): LegacyPlan {
  const monday = fromDateKey(doc.weekStartsOn);
  const parents = new Set(doc.blocks.filter((b) => b.parentId).map((b) => b.parentId!));
  const events: EventInput[] = [];
  const skippedForShabbat: string[] = [];
  for (const b of doc.blocks) {
    if (b.system || b.locked || parents.has(b.id)) continue;
    const day = addDays(monday, DAYS.indexOf(b.day));
    const start = atMinute(day, b.startMinute);
    const end = atMinute(day, Math.min(b.endMinute, 24 * 60));
    if (!(end > start)) continue;
    const input: EventInput = {
      calendarId,
      title: b.title.slice(0, 300),
      description: (b.description ?? "").slice(0, 8000),
      location: "",
      allDay: false,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone,
      recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [day.getDay()] },
      exdates: [],
      recurringEventId: null,
      originalStart: null,
      color: HUE[b.category] ?? null,
      reminders: [],
      guests: [],
      busy: true,
    };
    // Friday afternoon blocks can collide with winter Shabbat; they are left
    // out and named, rather than imported and then refused by the server.
    if (shabbatConflict(input, prefs)) skippedForShabbat.push(`${b.day} ${b.title}`);
    else events.push(input);
  }
  return { events, skippedForShabbat };
}
