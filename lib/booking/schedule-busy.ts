/**
 * A host's own Schedule (lib/calendar, migration 186) as busy time for booking.
 *
 * Before this, the public calendar read only the founders' Google calendars, so
 * a meeting CC put on the Schedule itself was offered to prospects as free.
 *
 * What counts as busy:
 *   - every event shown as busy (EventRecord.busy), on any of the host's calendars,
 *     with repeating series expanded by the Schedule's own expander;
 *   - an all-day event blocks that whole day in the booking time zone.
 * What never counts:
 *   - the restored weekly routine (rows tagged ROUTINE_ID_PREFIX). It is a plan
 *     of CC's day (client work 10:00-13:00, systems, R&D ...), and it covers the
 *     very hours CC chose to take calls in; counting it would close every slot.
 *
 * Pure. ASCII only.
 */

import { expandOccurrences } from "@/lib/calendar/recurrence";
import { ROUTINE_ID_PREFIX } from "@/lib/calendar/routine";
import type { EventRecord } from "@/lib/calendar/types";
import { instantOfLocal, type BusyInterval } from "./hours";

function isRoutine(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(ROUTINE_ID_PREFIX);
}

function dateKeyOf(local: Date): string {
  return [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, "0"),
    String(local.getDate()).padStart(2, "0"),
  ].join("-");
}

export function scheduleBusyIntervals(
  events: EventRecord[],
  timeMin: number,
  timeMax: number,
  timeZone: string,
): BusyInterval[] {
  // Widen by a day each side so an all-day event, whose expansion uses the
  // runtime's local midnight, is never clipped before it is re-anchored below.
  const occurrences = expandOccurrences(events, new Date(timeMin - 86_400_000), new Date(timeMax + 86_400_000));
  const busy: BusyInterval[] = [];
  for (const occ of occurrences) {
    if (!occ.event.busy) continue;
    if (isRoutine(occ.event.id) || isRoutine(occ.event.recurringEventId) || isRoutine(occ.master?.id)) continue;
    let start: number;
    let end: number;
    if (occ.allDay) {
      // expandOccurrences builds all-day instances from local-midnight Dates
      // (fromDateKey); their local fields ARE the calendar dates. Re-anchor them
      // to midnight in the booking zone, end exclusive.
      start = instantOfLocal(dateKeyOf(occ.start), 0, timeZone).getTime();
      end = instantOfLocal(dateKeyOf(occ.end), 0, timeZone).getTime();
    } else {
      start = occ.start.getTime();
      end = occ.end.getTime();
    }
    if (!(end > start) || end <= timeMin || start >= timeMax) continue;
    busy.push({ start, end });
  }
  return busy;
}
