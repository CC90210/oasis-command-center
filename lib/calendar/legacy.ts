/**
 * One-time import of the old browser-only weekly schedule (lib/schedule/model.ts)
 * into real, repeating calendar events.
 *
 * The old page saved a template week per browser under `oasis.schedule.*`.
 * Each editable block becomes a weekly series on its weekday, starting the
 * week it was saved. System Shabbat blocks are skipped: Shabbat is now
 * computed from the sunset, not stored. A "Work" container whose children
 * were shown instead of it is skipped the same way the old page hid it.
 *
 * Near Shabbat each series goes through the same splitter the routine restore
 * uses (routine.ts planAroundShabbat): a winter Friday afternoon is shortened
 * to end before candle-lighting, or left out that week, instead of the whole
 * block being dropped because some Fridays collide.
 */

import { DAYS, isScheduleDocument, type ScheduleDocument } from "@/lib/schedule/model";
import { addDays, atMinute, fromDateKey, isDateKey } from "./dates";
import { BLOCK_HUE, planAroundShabbat } from "./routine";
import type { CalendarPrefs, EventInput } from "./types";
import { shabbatConflict } from "./validate";

export const LEGACY_KEY_PREFIX = "oasis.schedule";

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

export type LegacyPlan = {
  events: EventInput[];
  /** Blocks with no week left: every one fell inside Shabbat. */
  skippedForShabbat: string[];
  /** Blocks shortened or left out on the weeks that meet Shabbat. */
  adjustedForShabbat: string[];
};

export function planLegacyImport(doc: ScheduleDocument, calendarId: string, timeZone: string, prefs: CalendarPrefs): LegacyPlan {
  const monday = fromDateKey(doc.weekStartsOn);
  const parents = new Set(doc.blocks.filter((b) => b.parentId).map((b) => b.parentId!));
  const events: EventInput[] = [];
  const skippedForShabbat: string[] = [];
  const adjustedForShabbat: string[] = [];
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
      color: BLOCK_HUE[b.category] ?? null,
      reminders: [],
      guests: [],
      busy: true,
    };
    const split = planAroundShabbat(input, prefs);
    // What the server would still refuse is named and left out, never sent.
    const planned = [...(split.series ? [split.series] : []), ...split.singles].filter((e) => !shabbatConflict(e, prefs));
    if (!planned.length) skippedForShabbat.push(`${b.day} ${b.title}`);
    else {
      events.push(...planned);
      if (split.through) adjustedForShabbat.push(`${b.day} ${b.title}`);
    }
  }
  return { events, skippedForShabbat, adjustedForShabbat };
}
