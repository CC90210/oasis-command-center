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
 * IDEMPOTENT BY LEAD. The event id is derived from the lead id, so a rep who
 * reschedules the same lead three times ends with ONE event at the latest time
 * instead of three stale reminders. A calendar a rep learns to ignore is worse
 * than no calendar at all.
 */

import {
  upsertCalendarEvent,
  cancelCalendarEvent,
  type CalendarFailure,
} from "@/lib/integrations/google-calendar";
import { type CallDisposition } from "@/lib/website-sales-workflow";
import { WEBDEV_TENANT_ID } from "./data";

/**
 * `skipped` was removed on 2026-08-24 along with the bug it existed for. Once
 * "no next action" means "delete the reminder" rather than "do nothing", there
 * is no path that skips, and a state the code can never produce is a lie in the
 * type that a future reader would write a branch for.
 */
export type CalendarSyncStatus =
  | { state: "synced"; eventId: string; htmlLink: string | null }
  | { state: "cleared" }
  | { state: "not_connected" }
  | { state: "failed"; reason: CalendarFailure; detail?: string };

/**
 * The de-duplication key for a lead's single outstanding "call them" reminder.
 *
 * Keyed on the LEAD, deliberately, not on the call. One lead has at most one
 * next action at a time, so one event per lead is the correct model and makes
 * rescheduling an update rather than an addition.
 */
export function nextActionEventKey(leadId: string): string {
  return `weblead-next-${leadId}`;
}

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
  businessName: string;
  disposition: CallDisposition;
  phone: string | null;
  note: string | null;
  leadUrl: string | null;
}): string {
  const lines = [
    `Last call: ${input.disposition.replace(/_/g, " ")}`,
    input.phone ? `Phone: ${input.phone}` : null,
    input.note ? `Your note: ${input.note}` : null,
    input.leadUrl ? `Open the lead: ${input.leadUrl}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Mirror this lead's next action onto the rep's calendar.
 *
 * Call it AFTER the lead write has succeeded, never before and never instead.
 * It returns a status for the caller to show; it does not throw, because a
 * calendar problem is not a reason to fail a call that was genuinely logged.
 */
export async function pushNextActionToCalendar(input: {
  leadId: string;
  repUserId: string;
  businessName: string;
  disposition: CallDisposition;
  nextActionAt: string | null;
  phone?: string | null;
  note?: string | null;
  leadUrl?: string | null;
}): Promise<CalendarSyncStatus> {
  const key = nextActionEventKey(input.leadId);

  // NO NEXT ACTION MEANS NO REMINDER, WHATEVER THE DISPOSITION.
  //
  // This branch used to delete only for TERMINAL dispositions and merely skip
  // otherwise (Codex review, 2026-08-24). But callDispositionPatch CLEARS
  // `next_action_at` for any disposition logged without one -- so a lead with
  // a callback on the rep's phone, later logged `connected` or `interested`
  // with no follow-up, kept ringing for a call the queue no longer had. The
  // mirror outlived what it mirrored, which is the one thing this module
  // exists to prevent.
  //
  // Terminal dispositions are the sharpest case rather than the only one: a
  // prospect who asked us never to call again must not have a reminder waiting
  // on anyone's phone. But the rule is simply that the phone matches the queue.
  if (!input.nextActionAt) {
    const cleared = await cancelCalendarEvent(WEBDEV_TENANT_ID, input.repUserId, key);
    if (cleared.ok) return { state: "cleared" };
    if (cleared.reason === "not_connected") return { state: "not_connected" };
    return { state: "failed", reason: cleared.reason, detail: cleared.detail };
  }

  const result = await upsertCalendarEvent(WEBDEV_TENANT_ID, input.repUserId, {
    summary: eventSummary(input.businessName),
    description: eventDescription({
      businessName: input.businessName,
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
    idempotencyKey: key,
  });

  if (result.ok) return { state: "synced", eventId: result.eventId, htmlLink: result.htmlLink };
  if (result.reason === "not_connected") return { state: "not_connected" };
  return { state: "failed", reason: result.reason, detail: result.detail };
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
