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
 * works the host is ready, and the status says whose sign-in did it. When it
 * fails, the error says why. This file only reports: it changes nothing about
 * availability or booking, so a host whose calendar truly cannot be read still
 * closes their own on-duty slots (the organizer: every slot).
 *
 * "Ready" means the calendar answered a 15-minute read just now. It does not
 * promise /book will offer times: /book reads up to maxDaysAhead (a calendar
 * with more than one page of events in that span makes that read fail) and also
 * needs the host's Schedule rows to load in full (public-booking.ts
 * schedule_events_truncated). Neither is visible from a 15-minute read.
 *
 * Each GET of the card now spends Google calls, so a host's answer is kept for
 * HOST_STATUS_TTL_MS and one host's read may take at most HOST_STATUS_DEADLINE_MS
 * (past that the card says "Status unavailable"). The kept answers are settled
 * values only, never a pending promise: a Worker shares module memory across
 * requests (tests/worker-request-isolation.test.ts). That slows a loop of GETs
 * in one isolate; it does not cap a burst of simultaneous first requests, and
 * isolates share nothing.
 *
 * ASCII only.
 */

import "server-only";
import {
  GoogleCalendarIntegrationError,
  listGoogleCalendarBusy,
  systemCalendarConfig,
} from "@/lib/integrations/google-calendar";
import { readPersonalGoogleFact } from "@/lib/integrations/personal-google";
import { personalGoogleStatus } from "@/lib/os/connectors";
import type { BookingHostIdentity } from "./settings-store";

/**
 * What the card says about one host's calendar. `kind` is what the card acts on;
 * `label` is the words.
 *   connected         the read works (on the host's own sign-in, or on one the
 *                     card cannot name because the host's own connection could
 *                     not be checked)
 *   workspace         the read works through the workspace credential, which is
 *                     the host's own Google account
 *   needs_connection  the read fails and only the host can fix it, by
 *                     connecting or reconnecting their Google account
 *   unavailable       the read could not be made or understood. This says
 *                     nothing about whether the host is connected.
 */
export type HostCalendarStatus =
  | { ready: true; kind: "connected" | "workspace"; label: string }
  | { ready: false; kind: "needs_connection" | "unavailable"; label: string };

/** The label of a host whose calendar reads through the workspace credential: "...(address)" follows. */
export const WORKSPACE_CALENDAR_LABEL = "Connected through the workspace calendar";

/** How far ahead the status read looks: it only needs to see the calendar answer. */
const PROBE_WINDOW_MS = 15 * 60_000;

/** How long a host's answer is kept: short enough that a person who has just connected Google sees it soon. */
export const HOST_STATUS_TTL_MS = 30_000;

/** The longest one host's status may take before the card says it could not be checked. */
export const HOST_STATUS_DEADLINE_MS = 8_000;

const UNAVAILABLE_LABEL = "Status unavailable";
const unavailable = (): HostCalendarStatus => ({ ready: false, kind: "unavailable", label: UNAVAILABLE_LABEL });
const needsConnection = (label: string): HostCalendarStatus => ({ ready: false, kind: "needs_connection", label });

type CachedStatus = { at: number; status: HostCalendarStatus };
/** Settled answers by host. Never a promise: see the note above. */
const hostStatusCache = new Map<string, CachedStatus>();

export type HostCalendarStatusDeps = {
  /** The read availability makes. */
  listBusy: typeof listGoogleCalendarBusy;
  /** The person's own Google connection, as presence and non-secret fields. */
  readPersonalFact: typeof readPersonalGoogleFact;
  /** The workspace calendar's address, when one is configured. */
  workspaceAddress: () => string | null;
  now: () => number;
  /** Kept answers (hostCalendarStatuses). */
  cache: Map<string, CachedStatus>;
  /** The longest one host's status may take. */
  deadlineMs: number;
};

const LIVE_DEPS: HostCalendarStatusDeps = {
  listBusy: listGoogleCalendarBusy,
  readPersonalFact: readPersonalGoogleFact,
  workspaceAddress: () => systemCalendarConfig()?.organizerEmail || null,
  now: () => Date.now(),
  cache: hostStatusCache,
  deadlineMs: HOST_STATUS_DEADLINE_MS,
};

/** Forget every kept answer (for tests: each state they set up must be read fresh). */
export function clearHostCalendarStatusCache(): void {
  hostStatusCache.clear();
}

function logStatusProblem(userId: string, error: unknown): void {
  const google = error instanceof GoogleCalendarIntegrationError ? error : null;
  console.error("[calendar.booking.host-status]", {
    userId,
    code: google?.code ?? "unexpected",
    detail: google?.detail ?? (error instanceof Error ? error.message : String(error)),
  });
}

/**
 * Google refused the saved grant itself: a refresh answered 400 invalid_grant.
 * This is /book's rule (lib/forms/public-booking.ts isUnconnectedCalendar): a
 * refresh that fails any other way (a timeout, a network error, a 5xx) says
 * nothing about the grant. For workspace_calendar_token_invalid the refusal
 * that decided it is its cause.
 */
function isDeadGrant(error: GoogleCalendarIntegrationError): boolean {
  const refusal =
    error.code === "workspace_calendar_token_invalid" && error.cause instanceof GoogleCalendarIntegrationError ? error.cause : error;
  return refusal.code === "token_refresh_failed" && refusal.httpStatus === 400 && refusal.detail.includes("invalid_grant");
}

/**
 * The read said the host has not connected. That comes from the bundle reader
 * the send path uses, which turns an unreadable credentials table, or a value
 * that will not decrypt, into an empty bundle. The status reader throws there,
 * so ask it once: if it cannot answer, the card cannot say "Not connected".
 */
async function confirmNotConnected(host: { tenantId: string; userId: string }, deps: HostCalendarStatusDeps): Promise<HostCalendarStatus> {
  try {
    await deps.readPersonalFact(host.tenantId, host.userId);
  } catch (error) {
    logStatusProblem(host.userId, error);
    return unavailable();
  }
  // A host who simply has not connected is a normal state, not a fault: it is said, not logged.
  return needsConnection("Not connected");
}

async function failedRead(host: { tenantId: string; userId: string }, error: unknown, deps: HostCalendarStatusDeps): Promise<HostCalendarStatus> {
  const google = error instanceof GoogleCalendarIntegrationError ? error : null;
  if (google?.code === "google_calendar_not_connected") return confirmNotConnected(host, deps);
  logStatusProblem(host.userId, error);
  if (!google) return unavailable();
  if (google.code === "calendar_scope_required") return needsConnection("Needs calendar permission");
  if (google.code === "calendar_organizer_mismatch") return needsConnection("Connected to a different Google account");
  if (google.code === "token_refresh_failed" || google.code === "workspace_calendar_token_invalid") {
    return isDeadGrant(google) ? needsConnection("Sign-in expired") : unavailable();
  }
  return unavailable();
}

/** The calendar read works. Say whose sign-in did it: the host's own, or the workspace's. */
async function readableCalendar(host: { tenantId: string; userId: string }, deps: HostCalendarStatusDeps): Promise<HostCalendarStatus> {
  let own: ReturnType<typeof personalGoogleStatus>;
  try {
    own = personalGoogleStatus(await deps.readPersonalFact(host.tenantId, host.userId));
  } catch (error) {
    // The host is ready either way. Only whose sign-in did the read is unknown, so say neither.
    logStatusProblem(host.userId, error);
    return { ready: true, kind: "connected", label: "Calendar readable" };
  }
  if (own.state === "ready") return { ready: true, kind: "connected", label: own.label };
  const address = deps.workspaceAddress();
  return { ready: true, kind: "workspace", label: address ? `${WORKSPACE_CALENDAR_LABEL} (${address})` : WORKSPACE_CALENDAR_LABEL };
}

async function readStatus(host: { tenantId: string; userId: string; email: string }, deps: HostCalendarStatusDeps): Promise<HostCalendarStatus> {
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
    return failedRead(host, error, deps);
  }
  return readableCalendar(host, deps);
}

/** `work`'s answer, or `onTimeout()` once `ms` have passed. The work is not cancelled; its late answer is dropped. */
async function within<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One host: the same read availability makes, for a moment from now, for the
 * host's own address. A read that works is ready; a read that fails says why;
 * one that takes longer than the deadline is "Status unavailable".
 */
export function hostCalendarStatus(
  host: { tenantId: string; userId: string; email: string },
  deps: HostCalendarStatusDeps = LIVE_DEPS,
): Promise<HostCalendarStatus> {
  return within(readStatus(host, deps), deps.deadlineMs, () => {
    logStatusProblem(host.userId, new Error(`no answer within ${deps.deadlineMs} ms`));
    return unavailable();
  });
}

async function keptStatus(host: { tenantId: string; userId: string; email: string }, deps: HostCalendarStatusDeps): Promise<HostCalendarStatus> {
  const key = `${host.tenantId}|${host.userId}|${host.email}`;
  const kept = deps.cache.get(key);
  if (kept && deps.now() - kept.at < HOST_STATUS_TTL_MS) return kept.status;
  const status = await hostCalendarStatus(host, deps);
  const now = deps.now();
  for (const [other, entry] of deps.cache) {
    if (now - entry.at >= HOST_STATUS_TTL_MS) deps.cache.delete(other);
  }
  deps.cache.set(key, { at: now, status });
  return status;
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
        return unavailable();
      }
      return keptStatus({ tenantId: input.tenantId, userId: host.userId, email: identity.email }, deps);
    }),
  );
}
