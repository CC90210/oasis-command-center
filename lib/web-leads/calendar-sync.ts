/**
 * lib/web-leads/calendar-sync.ts — mirroring a rep's next action onto their own
 * Google Calendar, so it reaches the phone in their pocket.
 *
 * THE OPERATOR ASK (Adon, 2026-08-23): "I just want everyone to be able to have
 * it on their phone so I can send them calls." A callback that lives only in a
 * dashboard tab is a callback a rep sees when they next open the dashboard,
 * which on a Thursday afternoon is exactly too late. Their phone already syncs
 * Google Calendar, with a lock-screen notification and no app to install.
 *
 * THE ORDERING RULE, AND IT IS THE WHOLE DESIGN:
 *
 *   1. append-only call history        (the record of what happened)
 *   2. the lead patch                  (the queue -- SOURCE OF TRUTH)
 *   3. the calendar push               (a MIRROR, best effort)
 *
 * A calendar failure must never lose a callback, and must never be reported as
 * a lost callback either. Step 3 failing means "it is in your queue but not on
 * your phone", which is a degraded feature, not a dropped promise. That is why
 * this module returns a status the caller SURFACES rather than throwing:
 * swallowing it would tell a rep their phone will remind them when it will not,
 * and throwing would undo a call that genuinely was logged.
 *
 * A REP WITH NO GOOGLE CONNECTION LOSES NOTHING. `not_connected` is a normal,
 * expected, non-error state, reported once so it can be shown as an invitation
 * to connect rather than retried forever in the background.
 *
 * ONE REMINDER PER LEAD, TRACKED BY A STORED ID.
 *
 * `data.next_action_event_id` on the lead holds whatever id Google assigned.
 * Earlier versions derived a DETERMINISTIC id from the lead so nothing had to
 * be stored, and five consecutive review rounds each found a defect in that
 * approach. Every one had the same root: once an event with a caller-supplied
 * id is deleted or cancelled, that id is ambiguous forever after, and Google's
 * 409/410/404 behaviour across live events, retained tombstones and freed ids
 * cannot be verified from here. Remembering the id Google hands back removes
 * the question entirely, because an id is never reused after its event is
 * removed. See writeReminderEvent's header for the full chain.
 */

import {
  writeReminderEvent,
  removeReminderEvent,
  type CalendarFailure,
} from "@/lib/integrations/google-calendar";
import { type CallDisposition } from "@/lib/website-sales-workflow";
import { WEBDEV_TENANT_ID } from "./data";

/** Where the Google-assigned id lives on the lead. */
export const NEXT_ACTION_EVENT_ID_FIELD = "next_action_event_id";

export type CalendarSyncStatus =
  | { state: "synced"; eventId: string; htmlLink: string | null }
  | { state: "cleared" }
  | { state: "not_connected" }
  | { state: "failed"; reason: CalendarFailure; detail?: string };

/**
 * What the rep sees on their phone. Business name first: a lock-screen
 * notification is read in about a second, at arm's length, and "Call Rosetti
 * Plumbing" is actionable where "Web lead follow up" is not.
 */
function eventSummary(businessName: string): string {
  const name = businessName.trim() || "web lead";
  return `Call ${name}`;
}

function eventDescription(input: {
  disposition: CallDisposition;
  phone: string | null;
  note: string | null;
  leadUrl: string | null;
}): string {
  return [
    `Last call: ${input.disposition.replace(/_/g, " ")}`,
    input.phone ? `Phone: ${input.phone}` : null,
    input.note ? `Your note: ${input.note}` : null,
    input.leadUrl ? `Open the lead: ${input.leadUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Mirror this lead's next action onto the rep's calendar.
 *
 * Call it AFTER the lead write has succeeded, never before and never instead.
 * It returns a status for the caller to show, plus the event id the caller must
 * PERSIST onto the lead. It does not throw: a calendar problem is not a reason
 * to fail a call that was genuinely logged.
 *
 * `eventId` in the result is the id to store. It is null when the reminder was
 * removed, which the caller should store too, so the next push knows there is
 * nothing to update.
 */
export async function pushNextActionToCalendar(input: {
  repUserId: string;
  businessName: string;
  disposition: CallDisposition;
  nextActionAt: string | null;
  /** The id we stored last time, or null if this lead has never had one. */
  existingEventId: string | null;
  phone?: string | null;
  note?: string | null;
  leadUrl?: string | null;
}): Promise<{ status: CalendarSyncStatus; eventId: string | null }> {
  // NO NEXT ACTION MEANS NO REMINDER, WHATEVER THE DISPOSITION.
  //
  // callDispositionPatch clears `next_action_at` for ANY disposition logged
  // without one, so a lead with a callback already on the rep's phone, later
  // logged `connected` or `interested` with no follow-up, would otherwise keep
  // ringing for a call the queue no longer has. The mirror must not outlive
  // what it mirrors. Terminal dispositions are the sharpest case rather than
  // the only one: a prospect who asked us never to call again must not have a
  // reminder waiting on anyone's phone.
  if (!input.nextActionAt) {
    const removed = await removeReminderEvent(WEBDEV_TENANT_ID, input.repUserId, input.existingEventId);
    if (removed.ok) return { status: { state: "cleared" }, eventId: null };
    if (removed.reason === "not_connected") {
      return { status: { state: "not_connected" }, eventId: input.existingEventId };
    }
    // The event may still be live, so KEEP the stored id. Dropping it here
    // would orphan a reminder that nothing could ever clear again.
    return {
      status: { state: "failed", reason: removed.reason, detail: removed.detail },
      eventId: input.existingEventId,
    };
  }

  const result = await writeReminderEvent(WEBDEV_TENANT_ID, input.repUserId, input.existingEventId, {
    summary: eventSummary(input.businessName),
    description: eventDescription({
      disposition: input.disposition,
      phone: input.phone ?? null,
      note: input.note ?? null,
      leadUrl: input.leadUrl ?? null,
    }),
    startAt: input.nextActionAt,
    // Fifteen minutes: long enough to be a real block on a calendar, short
    // enough that a day of callbacks does not look fully booked.
    defaultMinutes: 15,
    // Ten minutes' warning. A rep needs time to open the lead and read the
    // talking points before dialling, not a notification as it starts.
    reminderMinutes: 10,
  });

  if (result.ok) {
    return {
      status: { state: "synced", eventId: result.eventId, htmlLink: result.htmlLink },
      eventId: result.eventId,
    };
  }
  if (result.reason === "not_connected") {
    return { status: { state: "not_connected" }, eventId: input.existingEventId };
  }
  return {
    status: { state: "failed", reason: result.reason, detail: result.detail },
    eventId: input.existingEventId,
  };
}

/**
 * Undo a reminder we created but could not record.
 *
 * The caller stores the event id on the lead AFTER Google creates the event.
 * If that store fails, the event exists and nothing knows its id -- so a later
 * "clear this reminder" would address a null id, succeed vacuously, and leave a
 * live alert on the rep's phone forever. For a do-not-call that means ringing a
 * prospect who asked us never to be called again.
 *
 * Rolling the event back returns us to the clean state of "no reminder", which
 * is recoverable: the rep's queue is still correct and the next disposition
 * will create a fresh one. Returns false when the rollback itself failed, so
 * the caller can say plainly that an unaddressable reminder may be live rather
 * than pretending it is not.
 */
export async function rollBackReminder(repUserId: string, eventId: string | null): Promise<boolean> {
  if (!eventId) return true;
  const removed = await removeReminderEvent(WEBDEV_TENANT_ID, repUserId, eventId);
  return removed.ok;
}

/**
 * Plain-language status for a rep. Returned to the client rather than composed
 * there so the wording stays consistent across the panel and Call Mode, and so
 * a new caller cannot invent a cheerier version of a failure.
 */
export function describeCalendarSync(status: CalendarSyncStatus): string | null {
  switch (status.state) {
    case "synced":
      return null; // Working as intended needs no announcement.
    case "cleared":
      return null;
    case "not_connected":
      return "Saved to your queue. Connect Google Calendar in Settings to also get it on your phone.";
    case "failed":
      return "Saved to your queue, but it did not reach your Google Calendar. Check Settings.";
  }
}
