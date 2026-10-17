/**
 * Whether each booking host's Google Calendar can be read, for the Schedule's
 * "Booking link" card (app/api/calendar/booking).
 *
 * The card used to answer from the person's OWN Google connection alone
 * (readPersonalGoogleFact + personalGoogleStatus). Availability does not: it
 * reads a host's free time through listGoogleCalendarBusy, which also uses the
 * workspace calendar credential when that credential IS the host's own Google
 * account (allowSystemFallback "same_account"). That is CC's case, and the card
 * told him "Not connected. No times can be offered" while /book was offering
 * times.
 *
 * So the status now comes from the SAME call, with the same arguments
 * (lib/forms/public-booking.ts loadPublicBookingAvailability). When that read
 * works the host is ready, and the label says whose sign-in did it. When it
 * fails, the error's code says why. This file only reports: it changes nothing
 * about availability or booking, so a host whose calendar truly cannot be read
 * still closes their own on-duty slots (the organizer: every slot).
 *
 * ASCII only.
 */

import "server-only";
import {
  GoogleCalendarIntegrationError,
  listGoogleCalendarBusy,
  systemCalendarConfig,
  type GoogleCalendarErrorCode,
} from "@/lib/integrations/google-calendar";
import { readPersonalGoogleFact } from "@/lib/integrations/personal-google";
import { personalGoogleStatus } from "@/lib/os/connectors";
import type { BookingHostIdentity } from "./settings-store";

export type HostCalendarStatus = { ready: boolean; label: string };

/**
 * The start of the label for a host whose calendar reads through the workspace
 * credential instead of their own sign-in. The card shows such a label as a
 * quiet line, so CC can see why it works (BookingLinkCard matches this phrase).
 */
export const WORKSPACE_CALENDAR_LABEL = "Connected through the workspace calendar";

/** How far ahead the status read looks: it only needs to see the calendar answer. */
const PROBE_WINDOW_MS = 15 * 60_000;

const NOT_CONNECTED = "Not connected";
const STATUS_UNAVAILABLE = "Status unavailable";

/** What a failed read means to the person who has to fix it. Any other code is "Status unavailable". */
const READ_FAILURE_LABELS: Partial<Record<GoogleCalendarErrorCode, string>> = {
  google_calendar_not_connected: NOT_CONNECTED,
  calendar_scope_required: "Needs calendar permission",
  calendar_organizer_mismatch: "Connected to a different Google account",
  token_refresh_failed: "Sign-in expired",
  workspace_calendar_token_invalid: "Sign-in expired",
};

export type HostCalendarStatusDeps = {
  /** The read availability makes. */
  listBusy: typeof listGoogleCalendarBusy;
  /** The person's own Google connection, as presence and non-secret fields. */
  readPersonalFact: typeof readPersonalGoogleFact;
  /** The workspace calendar's address, when one is configured. */
  workspaceAddress: () => string | null;
  now: () => number;
};

const LIVE_DEPS: HostCalendarStatusDeps = {
  listBusy: listGoogleCalendarBusy,
  readPersonalFact: readPersonalGoogleFact,
  workspaceAddress: () => systemCalendarConfig()?.organizerEmail || null,
  now: () => Date.now(),
};

function logStatusProblem(userId: string, error: unknown): void {
  console.error("[calendar.booking.host-status]", {
    userId,
    code: error instanceof GoogleCalendarIntegrationError ? error.code : "unexpected",
    detail: error instanceof GoogleCalendarIntegrationError ? error.detail : error instanceof Error ? error.message : String(error),
  });
}

/** A host who simply has not connected is a normal state, not a fault: it is said, not logged. */
function failedRead(userId: string, error: unknown): HostCalendarStatus {
  const code = error instanceof GoogleCalendarIntegrationError ? error.code : null;
  if (code !== "google_calendar_not_connected") logStatusProblem(userId, error);
  return { ready: false, label: (code && READ_FAILURE_LABELS[code]) || STATUS_UNAVAILABLE };
}

/** The calendar read works. Say whose sign-in did it: the host's own, or the workspace's. */
async function readableCalendar(host: { tenantId: string; userId: string }, deps: HostCalendarStatusDeps): Promise<HostCalendarStatus> {
  let own: ReturnType<typeof personalGoogleStatus>;
  try {
    own = personalGoogleStatus(await deps.readPersonalFact(host.tenantId, host.userId));
  } catch (error) {
    // The host is ready either way. Only whose sign-in did the read is unknown, so say neither.
    logStatusProblem(host.userId, error);
    return { ready: true, label: "Calendar readable" };
  }
  if (own.state === "ready") return { ready: true, label: own.label };
  const address = deps.workspaceAddress();
  return { ready: true, label: address ? `${WORKSPACE_CALENDAR_LABEL} (${address})` : WORKSPACE_CALENDAR_LABEL };
}

/**
 * One host: the same read availability makes, for a moment from now, for the
 * host's own address. A read that works is ready; a read that fails says why.
 */
export async function hostCalendarStatus(
  host: { tenantId: string; userId: string; email: string },
  deps: HostCalendarStatusDeps = LIVE_DEPS,
): Promise<HostCalendarStatus> {
  const from = deps.now();
  try {
    await deps.listBusy({
      tenantId: host.tenantId,
      organizerUserId: host.userId,
      expectedOrganizerEmail: host.email,
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(from + PROBE_WINDOW_MS).toISOString(),
    });
  } catch (error) {
    return failedRead(host.userId, error);
  }
  return readableCalendar(host, deps);
}

/** Every configured host, in order. A host missing from the roster cannot be read, as in availability. */
export function hostCalendarStatuses(
  input: {
    tenantId: string;
    hosts: ReadonlyArray<{ userId: string }>;
    identities: ReadonlyMap<string, BookingHostIdentity>;
  },
  deps: HostCalendarStatusDeps = LIVE_DEPS,
): Promise<HostCalendarStatus[]> {
  return Promise.all(
    input.hosts.map(async (host) => {
      const identity = input.identities.get(host.userId);
      if (!identity) {
        logStatusProblem(host.userId, new Error("booking_host_not_on_roster"));
        return { ready: false, label: STATUS_UNAVAILABLE };
      }
      return hostCalendarStatus({ tenantId: input.tenantId, userId: host.userId, email: identity.email }, deps);
    }),
  );
}
