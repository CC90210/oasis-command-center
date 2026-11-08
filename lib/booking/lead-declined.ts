import "server-only";
import {
  readGoogleFounderMeetingResponse,
  type FounderMeetingAttendeeResponse,
  type ReadFounderMeetingResponseInput,
} from "@/lib/integrations/google-calendar";

/**
 * Has the lead declined the invite, on Google's own word?
 *
 * 2026-11-07: a lead declined an audit at 05:11 and was still sent the 60-, 30-
 * and 15-minute reminders, the founder got "In 15 minutes", and at the meeting
 * time the lead got "Sorry we missed each other" while the founder was told
 * "Missed". Nothing read the RSVP. The invite's answer is the lead's latest
 * word, so it is read at the moment it matters (before a reminder, before the
 * founder's heads-up, at the no-show check), never cached across runs: a lead
 * who declines and then accepts again is reminded again.
 *
 * Fails OPEN: no event, a read error, or an event that is gone reads as "not
 * declined", so an unknown answer never stops a reminder that would have gone.
 */
export type DeclineCheckAppointment = {
  id: string;
  tenant_id: string;
  assigned_to: string | null;
  google_event_id: string | null;
  organizer_email_snapshot: string | null;
  client_email_snapshot: string | null;
};

export type ReadAttendeeResponse = (input: ReadFounderMeetingResponseInput) => Promise<FounderMeetingAttendeeResponse>;

/**
 * How long the reminder run waits for Google's answer. A Google call may take
 * 15 s (30 s with a token refresh), and the dispatcher's whole run has 45 s:
 * a slow RSVP read must never hold up every other reminder, so past this it
 * reads as "not declined" and the reminder goes as before.
 */
export const RSVP_READ_BUDGET_MS = 4_000;

export async function leadDeclinedInvite(
  appointment: DeclineCheckAppointment,
  read: ReadAttendeeResponse = readGoogleFounderMeetingResponse,
  budgetMs: number = RSVP_READ_BUDGET_MS,
  /** Told when the read ran past its budget (declineCheckForRun stops asking Google). */
  onTimeout?: () => void,
): Promise<boolean> {
  if (
    !appointment.google_event_id ||
    !appointment.assigned_to ||
    !appointment.organizer_email_snapshot ||
    !appointment.client_email_snapshot
  ) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      read({
        tenantId: appointment.tenant_id,
        hostUserId: appointment.assigned_to,
        eventId: appointment.google_event_id,
        expectedOrganizerEmail: appointment.organizer_email_snapshot,
        attendeeEmail: appointment.client_email_snapshot,
      }),
      new Promise<"too_slow">((resolve) => {
        timer = setTimeout(() => resolve("too_slow"), budgetMs);
      }),
    ]);
    if (answer === "too_slow") {
      onTimeout?.();
      console.warn("[lead-declined] RSVP read over budget; treated as not declined", {
        appointment: appointment.id,
        budgetMs,
      });
      return false;
    }
    return answer === "declined";
  } catch (error) {
    console.warn("[lead-declined] RSVP read failed; treated as not declined", {
      appointment: appointment.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One read per appointment per run: several rows of one meeting can fall due
 * together. And at most ONE budget per run: once Google has been too slow,
 * the rest of the run's meetings read "not declined" without asking, so a
 * hung Google costs the dispatcher 4 s, not 4 s per meeting (CodeRabbit, #808).
 */
export function declineCheckForRun(
  read: ReadAttendeeResponse = readGoogleFounderMeetingResponse,
  budgetMs: number = RSVP_READ_BUDGET_MS,
): (appointment: DeclineCheckAppointment) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  let googleIsSlow = false;
  return (appointment) => {
    const key = `${appointment.tenant_id}:${appointment.id}`;
    let answer = seen.get(key);
    if (!answer) {
      answer = googleIsSlow
        ? Promise.resolve(false)
        : leadDeclinedInvite(appointment, read, budgetMs, () => {
            googleIsSlow = true;
          });
      seen.set(key, answer);
    }
    return answer;
  };
}
