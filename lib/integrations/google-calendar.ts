/**
 * Server-side Google Calendar adapter for the 15-minute founder audit.
 *
 * The adapter deliberately accepts no notes or free-form description. Internal
 * qualification and handoff context belongs in Turso, never in a client-visible
 * Calendar invite. The deterministic event ID makes an insert safe to retry:
 * Google returns 409 when the first attempt committed, and this adapter then
 * reads that exact event instead of creating a duplicate.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  getUserIntegrationBundle,
  setUserIntegrationValue,
  type UserIntegrationSetResult,
} from "@/lib/user-integration-store";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const WORK_OAUTH_SERVICE = "gmail_oauth";
const PRIMARY_CALENDAR_ID = "primary";
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const MEETING_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_POLL_ATTEMPTS = 4;
const DEFAULT_POLL_INTERVAL_MS = 500;
const PUBLIC_EVENT_DESCRIPTION = "A 15-minute website audit with OASIS AI Solutions.";

export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export type GoogleCalendarErrorCode =
  | "invalid_request"
  | "google_calendar_not_connected"
  | "calendar_scope_required"
  | "calendar_organizer_mismatch"
  | "google_oauth_config_missing"
  | "token_refresh_failed"
  | "calendar_create_failed"
  | "calendar_update_failed"
  | "calendar_cancel_failed"
  | "calendar_reconcile_failed"
  | "calendar_read_failed"
  | "google_meet_link_missing";

export class GoogleCalendarIntegrationError extends Error {
  readonly code: GoogleCalendarErrorCode;
  readonly detail: string;
  readonly httpStatus?: number;
  readonly eventId?: string;

  constructor(
    code: GoogleCalendarErrorCode,
    message: string,
    options: { httpStatus?: number; eventId?: string; cause?: unknown } = {},
  ) {
    // The message is intentionally the stable machine-readable error expected
    // by routes/workers. Human detail remains available without brittle parsing.
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GoogleCalendarIntegrationError";
    this.code = code;
    this.detail = message;
    this.httpStatus = options.httpStatus;
    this.eventId = options.eventId;
  }
}

export type FounderMeetingCalendarRequest = {
  tenantId: string;
  /** User whose work `gmail_oauth` bundle owns the Calendar event. */
  organizerUserId: string;
  /** Exact approved work address for the host; personal Gmail must fail before any provider call. */
  expectedOrganizerEmail?: string;
  /** Stable request UUID/idempotency key persisted with the booking intent. */
  bookingRequestId: string;
  /** An absolute ISO timestamp. Timezone is retained separately for display. */
  startAt: string;
  timeZone: string;
  clientEmail: string;
  clientName?: string;
  /** Opener rep copied on the invite when they are not the host/closer. */
  openerEmail?: string;
  openerDisplayName?: string;
  businessName?: string;
  website?: string;
  clientAgenda?: string;
  durationMinutes?: number;
};

/**
 * Workspace (system) Calendar credentials, read from the environment.
 *
 * Added 2026-08-25 (operator plan): hosts who never completed the personal
 * work-OAuth handshake were hard-blocked with "This host needs to reconnect
 * Google Calendar" even though OASIS owns a workspace calendar that can host
 * every audit. When these variables are present, a host without a usable
 * personal connection books on the WORKSPACE identity instead:
 *
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   (same OAuth client as personal mode)
 *   GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN      long-lived refresh token for the
 *                                             OASIS workspace account, granted
 *                                             https://www.googleapis.com/auth/calendar.events
 *   GOOGLE_SYSTEM_CALENDAR_ADDRESS            the workspace organizer address
 *                                             (used for receipts/identity)
 *   GOOGLE_CALENDAR_ID                        target calendar, default "primary"
 *
 * The workspace account becomes the event ORGANIZER; the human host is added
 * as an attendee so their calendar still shows the booking, and the client
 * invite/Meet flow is unchanged. Access-token refreshes in this mode are
 * deliberately NOT persisted into any user's integration store.
 */
export type SystemCalendarConfig = {
  refreshToken: string;
  organizerEmail: string;
  calendarId: string;
};

export function systemCalendarConfig(): SystemCalendarConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const refreshToken = (
    process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN ||
    process.env.GOOGLE_SYSTEM_REFRESH_TOKEN ||
    ""
  ).trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    refreshToken,
    organizerEmail: (process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS || "").trim().toLowerCase(),
    calendarId: (process.env.GOOGLE_CALENDAR_ID || "").trim() || PRIMARY_CALENDAR_ID,
  };
}

/** True when bookings can fall back to the workspace calendar identity. */
export function isSystemCalendarConfigured(): boolean {
  return systemCalendarConfig() !== null;
}

/** The workspace organizer address, when configured; null otherwise. */
export function systemOrganizerEmail(): string | null {
  return systemCalendarConfig()?.organizerEmail || null;
}

/**
 * Central inbox copied on every founder-audit invite so ops sees each booking
 * without relying on a rep forwarding it. Defaults to the operator address;
 * override with GOOGLE_FOUNDER_MEETING_CC_EMAIL.
 */
export function centralMeetingCcEmail(): string {
  return (process.env.GOOGLE_FOUNDER_MEETING_CC_EMAIL || "conaugh@oasisai.work")
    .trim()
    .toLowerCase();
}

export type GoogleCalendarReceipt = {
  calendarId: string;
  eventId: string;
  htmlLink: string;
  meetLink: string;
  iCalUID: string;
  organizerEmail: string;
};

export type CreateGoogleFounderMeetingInput = {
  tenantId: string;
  hostUserId: string;
  expectedOrganizerEmail: string;
  requestId: string;
  meetingAt: string;
  timezone: string;
  durationMinutes: number;
  clientEmail: string;
  clientName?: string;
  /** Opener rep copied on the invite when they are not the host/closer. */
  openerEmail?: string;
  openerDisplayName?: string;
  company?: string;
  website?: string;
  /** Client-visible agenda only. Internal qualification/handoff notes are forbidden. */
  clientAgenda: string;
};

export type UpdateGoogleFounderMeetingInput = {
  tenantId: string;
  hostUserId: string;
  expectedOrganizerEmail: string;
  eventId: string;
  meetingAt: string;
  timezone: string;
  durationMinutes: number;
  clientEmail: string;
  clientName?: string;
  /** Opener rep copied on the invite when they are not the host/closer. */
  openerEmail?: string;
  openerDisplayName?: string;
  company?: string;
  website?: string;
  /** Client-visible agenda only. Internal qualification/handoff notes are forbidden. */
  clientAgenda: string;
};

export type CancelGoogleFounderMeetingInput = {
  tenantId: string;
  hostUserId: string;
  expectedOrganizerEmail: string;
  eventId: string;
};

export type FounderMeetingCalendarReceipt = {
  provider: "google_calendar";
  /** "primary" for personal-host bookings, or the configured workspace calendar id. */
  calendarId: string;
  eventId: string;
  htmlUrl: string;
  meetUrl: string;
  iCalUID: string;
  status: string;
  organizerEmail: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  /** True when a retry found the already-created deterministic event. */
  reconciled: boolean;
};

type GoogleCalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  htmlLink?: string;
  iCalUID?: string;
  hangoutLink?: string;
  organizer?: { email?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
};

export type GoogleCalendarDependencies = {
  fetchImpl: typeof fetch;
  getBundle: (
    tenantId: string,
    userId: string,
    service: string,
  ) => Promise<Record<string, string>>;
  setValue: (
    tenantId: string,
    userId: string,
    service: string,
    fieldKey: string,
    value: string,
  ) => Promise<UserIntegrationSetResult>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pollAttempts: number;
  pollIntervalMs: number;
  oauthClientId: string;
  oauthClientSecret: string;
};

export function operatorCalendarStatus(
  tenantId: string,
  userId: string,
): Promise<{ connected: boolean; reason?: string; address?: string }>;
export function operatorCalendarStatus(
  tenantId: string,
  userId: string,
  dependencyOverrides: Pick<Partial<GoogleCalendarDependencies>, "getBundle">,
): Promise<{ connected: boolean; reason?: string; address?: string }>;
export async function operatorCalendarStatus(
  tenantId: string,
  userId: string,
  dependencyOverrides: Pick<Partial<GoogleCalendarDependencies>, "getBundle"> = {},
): Promise<{ connected: boolean; reason?: string; address?: string }> {
  const getBundle = dependencyOverrides.getBundle || getUserIntegrationBundle;
  const bundle =
    tenantId.trim() && userId.trim()
      ? await getBundle(tenantId, userId, WORK_OAUTH_SERVICE)
      : {};
  const address = bundle.gmail_address?.trim() || undefined;
  if (!bundle.refresh_token) {
    return {
      connected: false,
      reason: "google_calendar_not_connected",
      ...(address ? { address } : {}),
    };
  }
  if (!hasRequiredScope(bundle.scope)) {
    return {
      connected: false,
      reason: "calendar_scope_required",
      ...(address ? { address } : {}),
    };
  }
  return { connected: true, ...(address ? { address } : {}) };
}

function sha256Hex(
  namespace: string,
  tenantId: string,
  hostUserId: string,
  bookingRequestId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        namespace,
        tenantId.trim(),
        hostUserId.trim(),
        bookingRequestId.trim(),
      ]),
      "utf8",
    )
    .digest("hex");
}

/**
 * Google custom event IDs must be 5-1024 base32hex characters (`0-9`, `a-v`).
 * A SHA-256 hex digest is inside that alphabet and remains stable across retries.
 */
export function founderMeetingEventId(
  tenantId: string,
  hostUserId: string,
  bookingRequestId: string,
): string {
  return `oasis${sha256Hex(
    "founder-meeting-event",
    tenantId,
    hostUserId,
    bookingRequestId,
  )}`;
}

/** Stable per-booking Meet request ID; a different booking cannot reuse a room. */
export function founderMeetingConferenceRequestId(
  tenantId: string,
  hostUserId: string,
  bookingRequestId: string,
): string {
  return sha256Hex(
    "founder-meeting-conference",
    tenantId,
    hostUserId,
    bookingRequestId,
  );
}

function resolveDependencies(
  overrides: Partial<GoogleCalendarDependencies>,
): GoogleCalendarDependencies {
  return {
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    getBundle: overrides.getBundle || getUserIntegrationBundle,
    setValue: overrides.setValue || setUserIntegrationValue,
    now: overrides.now || Date.now,
    sleep:
      overrides.sleep ||
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    pollAttempts: overrides.pollAttempts ?? DEFAULT_POLL_ATTEMPTS,
    pollIntervalMs: overrides.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    oauthClientId: overrides.oauthClientId ?? process.env.GOOGLE_CLIENT_ID ?? "",
    oauthClientSecret:
      overrides.oauthClientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? "",
  };
}

function validateRequest(args: FounderMeetingCalendarRequest): {
  startAt: string;
  endAt: string;
  timeZone: string;
  clientEmail: string;
  website?: string;
} {
  if (!args.tenantId.trim() || !args.organizerUserId.trim() || !args.bookingRequestId.trim()) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "tenantId, organizerUserId, and bookingRequestId are required",
    );
  }

  const clientEmail = args.clientEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "a valid client email is required before booking",
    );
  }

  const startMilliseconds = Date.parse(args.startAt);
  if (!Number.isFinite(startMilliseconds)) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "startAt must be an absolute ISO timestamp",
    );
  }

  if (args.durationMinutes !== undefined && args.durationMinutes !== 15) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "founder audit meetings must be exactly 15 minutes",
    );
  }

  const timeZone = args.timeZone.trim();
  if (!timeZone) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "timeZone must be a valid IANA timezone",
    );
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(startMilliseconds);
  } catch (cause) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "timeZone must be a valid IANA timezone",
      { cause },
    );
  }

  let website: string | undefined;
  if (args.website?.trim()) {
    try {
      const parsed = new URL(args.website.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported_protocol");
      website = parsed.toString();
    } catch (cause) {
      throw new GoogleCalendarIntegrationError(
        "invalid_request",
        "website must be an absolute HTTP(S) URL",
        { cause },
      );
    }
  }

  return {
    startAt: new Date(startMilliseconds).toISOString(),
    endAt: new Date(startMilliseconds + MEETING_DURATION_MS).toISOString(),
    timeZone,
    clientEmail,
    website,
  };
}

function hasRequiredScope(scopeValue: string | undefined): boolean {
  return new Set((scopeValue || "").split(/\s+/u).filter(Boolean)).has(
    CALENDAR_EVENTS_SCOPE,
  );
}

async function responseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "response_body_unavailable";
  }
}

async function responseJson<T>(
  response: Response,
  code: GoogleCalendarErrorCode,
  eventId?: string,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new GoogleCalendarIntegrationError(code, "Google returned invalid JSON", {
      httpStatus: response.status,
      eventId,
      cause,
    });
  }
}

async function refreshAccessToken(args: {
  tenantId: string;
  organizerUserId: string;
  refreshToken: string;
  dependencies: GoogleCalendarDependencies;
  /** False in workspace-fallback mode: never write system tokens into a user's bundle. */
  persist?: boolean;
}): Promise<string> {
  const { dependencies } = args;
  if (!dependencies.oauthClientId || !dependencies.oauthClientSecret) {
    throw new GoogleCalendarIntegrationError(
      "google_oauth_config_missing",
      "Google OAuth client credentials are not configured",
    );
  }

  let response: Response;
  try {
    response = await dependencies.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
        client_id: dependencies.oauthClientId,
        client_secret: dependencies.oauthClientSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new GoogleCalendarIntegrationError(
      "token_refresh_failed",
      "Google access-token refresh failed",
      { cause },
    );
  }

  if (!response.ok) {
    throw new GoogleCalendarIntegrationError(
      "token_refresh_failed",
      `Google access-token refresh failed: ${await responseText(response)}`,
      { httpStatus: response.status },
    );
  }

  const payload = await responseJson<{
    access_token?: string;
    expires_in?: number;
    error?: string;
  }>(response, "token_refresh_failed");
  if (payload.error || !payload.access_token) {
    throw new GoogleCalendarIntegrationError(
      "token_refresh_failed",
      `Google access-token refresh failed: ${payload.error || "no_access_token"}`,
    );
  }

  const expiresAt = new Date(
    dependencies.now() + (payload.expires_in || 3600) * 1000,
  ).toISOString();
  if (args.persist === false) {
    return payload.access_token;
  }
  const persisted = await Promise.allSettled([
    dependencies.setValue(
      args.tenantId,
      args.organizerUserId,
      WORK_OAUTH_SERVICE,
      "access_token",
      payload.access_token,
    ),
    dependencies.setValue(
      args.tenantId,
      args.organizerUserId,
      WORK_OAUTH_SERVICE,
      "expires_at",
      expiresAt,
    ),
  ]);
  const persistenceFailed = persisted.some(
    (result) =>
      result.status === "rejected" ||
      (result.status === "fulfilled" && !result.value.ok),
  );
  if (persistenceFailed) {
    console.error("[google-calendar] refreshed token could not be persisted", {
      tenantId: args.tenantId,
      organizerUserId: args.organizerUserId,
    });
  }
  return payload.access_token;
}

function extractMeetUrl(event: GoogleCalendarEvent): string | null {
  const candidates = [
    event.hangoutLink,
    ...(event.conferenceData?.entryPoints || [])
      .filter((entry) => entry.entryPointType === "video")
      .map((entry) => entry.uri),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.hostname === "meet.google.com") {
        return parsed.toString();
      }
    } catch {
      // A malformed entry point is not a usable Meet receipt; inspect the next one.
    }
  }
  return null;
}

type ExpectedFounderMeetingEvent = {
  eventId: string;
  startAt: string;
  endAt: string;
  clientEmail: string;
  /**
   * Exact lowercase invitee set sent with the request. Google may additionally
   * echo the organizing account among attendees on reads, so the organizer is
   * tolerated separately — any other address fails closed.
   */
  attendeeEmails: string[];
  organizerEmail?: string;
  summary: string;
  description: string;
};

function assertFounderMeetingEventIdentity(
  event: GoogleCalendarEvent,
  expected: ExpectedFounderMeetingEvent,
  errorCode:
    | "calendar_create_failed"
    | "calendar_reconcile_failed"
    | "calendar_update_failed"
    | "calendar_read_failed",
): void {
  const fail = (reason: string): never => {
    throw new GoogleCalendarIntegrationError(
      errorCode,
      `Google Calendar booking identity mismatch: ${reason}`,
      { eventId: expected.eventId },
    );
  };
  if (event.id !== expected.eventId) fail("event_id");
  if (event.status !== "confirmed") fail("event_not_active");

  const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : Number.NaN;
  const end = event.end?.dateTime ? Date.parse(event.end.dateTime) : Number.NaN;
  if (!Number.isFinite(start) || start !== Date.parse(expected.startAt)) fail("start_time");
  if (!Number.isFinite(end) || end !== Date.parse(expected.endAt)) fail("end_time");

  const attendeeEmails = (event.attendees || [])
    .map((attendee) => attendee.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  const allowedAttendees = new Set(expected.attendeeEmails);
  if (expected.organizerEmail) allowedAttendees.add(expected.organizerEmail.trim().toLowerCase());
  if (
    !attendeeEmails.length ||
    !attendeeEmails.every((email) => allowedAttendees.has(email)) ||
    !attendeeEmails.includes(expected.clientEmail.trim().toLowerCase())
  ) {
    fail("client_attendee");
  }
  if (event.summary !== expected.summary) fail("summary");
  if (event.description !== expected.description) fail("description");
}

function eventTitle(businessName?: string): string {
  const business = businessName?.trim();
  return business
    ? `OASIS 15-minute website audit — ${business}`
    : "OASIS 15-minute website audit";
}

function publicEventDescription(clientAgenda?: string, website?: string): string {
  const agenda = clientAgenda?.trim();
  const sections = [PUBLIC_EVENT_DESCRIPTION];
  if (agenda) sections.push(`Agenda:\n${agenda}`);
  if (website) sections.push(`Website: ${website}`);
  return sections.join("\n\n");
}

type FounderMeetingInvitee = { email: string; displayName?: string };

/**
 * Deduplicated invite list for a founder-audit event: host (workspace-fallback
 * only — otherwise the host IS the organizer), opener rep, client, and the
 * central ops inbox. First occurrence wins, so an opener who is also the host,
 * or the CC address that matches any invitee/organizer, is never doubled.
 */
function founderMeetingInviteList(args: {
  clientEmail: string;
  clientName?: string;
  hostAttendeeEmail?: string;
  openerEmail?: string;
  openerDisplayName?: string;
}): FounderMeetingInvitee[] {
  const seen = new Set<string>();
  const attendees: FounderMeetingInvitee[] = [];
  const add = (rawEmail: string | undefined, displayName?: string) => {
    const email = rawEmail?.trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) return;
    seen.add(email);
    const name = displayName?.trim();
    attendees.push(name ? { email, displayName: name } : { email });
  };
  add(args.hostAttendeeEmail);
  add(args.openerEmail, args.openerDisplayName);
  add(args.clientEmail, args.clientName);
  add(centralMeetingCcEmail());
  return attendees;
}

type AuthorizedCalendarFetch = (
  url: string,
  init: RequestInit,
  networkErrorCode: GoogleCalendarErrorCode,
) => Promise<Response>;

async function openAuthorizedCalendarSession(args: {
  tenantId: string;
  organizerUserId: string;
  expectedOrganizerEmail?: string;
  dependencyOverrides?: Partial<GoogleCalendarDependencies>;
}): Promise<{
  dependencies: GoogleCalendarDependencies;
  bundle: Record<string, string>;
  authorizedFetch: AuthorizedCalendarFetch;
  /** True when the session runs on the workspace identity instead of the host's personal OAuth. */
  systemFallback: boolean;
  calendarId: string;
}> {
  const dependencies = resolveDependencies(args.dependencyOverrides || {});
  const bundle = await dependencies.getBundle(
    args.tenantId,
    args.organizerUserId,
    WORK_OAUTH_SERVICE,
  );

  // Workspace fallback (2026-08-25): a host without a usable personal work
  // connection no longer blocks the booking when workspace credentials are
  // configured. The strict per-host errors below are preserved verbatim when
  // no fallback exists, so fail-closed behaviour is unchanged otherwise.
  let systemFallback = false;
  let calendarId = PRIMARY_CALENDAR_ID;
  let sessionBundle = bundle;
  if (!bundle.refresh_token || !hasRequiredScope(bundle.scope)) {
    const system = systemCalendarConfig();
    if (system) {
      systemFallback = true;
      calendarId = system.calendarId;
      sessionBundle = {
        ...bundle,
        refresh_token: system.refreshToken,
        scope: CALENDAR_EVENTS_SCOPE,
        ...(system.organizerEmail ? { gmail_address: system.organizerEmail } : {}),
      };
    } else if (!bundle.refresh_token) {
      throw new GoogleCalendarIntegrationError(
        "google_calendar_not_connected",
        "the organizer has not connected the work Google account",
      );
    } else {
      throw new GoogleCalendarIntegrationError(
        "calendar_scope_required",
        `the work Google connection must grant ${CALENDAR_EVENTS_SCOPE}`,
      );
    }
  }

  const expectedOrganizerEmail = String(args.expectedOrganizerEmail || "").trim().toLowerCase();
  const connectedOrganizerEmail = String(sessionBundle.gmail_address || "").trim().toLowerCase();
  if (
    !systemFallback &&
    expectedOrganizerEmail &&
    (!connectedOrganizerEmail || connectedOrganizerEmail !== expectedOrganizerEmail)
  ) {
    throw new GoogleCalendarIntegrationError(
      "calendar_organizer_mismatch",
      "the connected Google account does not match the approved work identity",
    );
  }

  let accessToken = sessionBundle.access_token || "";
  const expiresAt = sessionBundle.expires_at ? Date.parse(sessionBundle.expires_at) : 0;
  /**
   * Refresh, and FALL BACK IF THE HOST'S TOKEN HAS BEEN REVOKED.
   *
   * ═══ THE GAP THIS CLOSES (live, 2026-08-26) ══════════════════════════════
   *
   * The workspace fallback above triggers on a token that is MISSING or
   * WRONG-SCOPED. It does not trigger on a token that is PRESENT and DEAD --
   * and revocation is the common case, not the rare one: a host changes their
   * Google password, or removes the app at myaccount.google.com/permissions,
   * and the stored refresh_token stays in the column looking perfectly healthy.
   *
   * So a host whose access had been withdrawn skipped the fallback entirely,
   * went straight to refreshAccessToken with a dead token, and the booking died
   * with `token_refresh_failed` -- WHILE A FULLY CONFIGURED WORKSPACE CALENDAR
   * SAT UNUSED. The operator reported it as "it says invalid token"; nothing
   * could book, and the credentials to book were already in production.
   *
   * Google reports revocation the same way it reports every other bad grant, so
   * the only way to learn it is to try. This tries, and on failure retries once
   * through the workspace identity when one is configured.
   *
   * WHAT IS DELIBERATELY PRESERVED:
   *
   *  - No fallback configured  -> the original error propagates unchanged.
   *    Fail-closed behaviour is not traded away for convenience.
   *  - Already on the fallback -> no retry. Retrying the system token with the
   *    system token is a loop that would turn one clear failure into two.
   *  - `persist` stays false on the fallback path, so a system token is never
   *    written into a user's bundle -- that would silently convert a temporary
   *    cover into the host's permanent stored identity.
   *
   * WHAT THE REP SEES CHANGES, AND THAT MATTERS: the invite now goes out
   * organised by the shared OASIS workspace address rather than by the host.
   * That is a real difference and the handoff banner says so before they book.
   * It is the right trade for a client-facing founder audit -- and it is NOT
   * extended to private rep reminders, which refuse this fallback on purpose
   * because it would publish a rep's own call notes to the whole workspace.
   */
  const refresh = async () => {
    try {
      accessToken = await refreshAccessToken({
        tenantId: args.tenantId,
        organizerUserId: args.organizerUserId,
        refreshToken: sessionBundle.refresh_token,
        dependencies,
        persist: !systemFallback,
      });
    } catch (error) {
      const revoked =
        error instanceof GoogleCalendarIntegrationError && error.code === "token_refresh_failed";
      const system = revoked && !systemFallback ? systemCalendarConfig() : null;
      if (!system) throw error;
      systemFallback = true;
      calendarId = system.calendarId;
      sessionBundle = {
        ...sessionBundle,
        refresh_token: system.refreshToken,
        scope: CALENDAR_EVENTS_SCOPE,
        ...(system.organizerEmail ? { gmail_address: system.organizerEmail } : {}),
      };
      accessToken = await refreshAccessToken({
        tenantId: args.tenantId,
        organizerUserId: args.organizerUserId,
        refreshToken: system.refreshToken,
        dependencies,
        persist: false,
      });
    }
  };
  if (
    !accessToken ||
    !Number.isFinite(expiresAt) ||
    expiresAt - dependencies.now() < ACCESS_TOKEN_REFRESH_SKEW_MS
  ) {
    await refresh();
  }

  const authorizedFetch: AuthorizedCalendarFetch = async (
    url,
    init,
    networkErrorCode,
  ) => {
    const requestTimeoutMs = init.method === "POST" || init.method === "PATCH" ? 20_000 : 15_000;
    const perform = () =>
      dependencies.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          authorization: `Bearer ${accessToken}`,
        },
        // A 401 refresh can consume most of the first attempt's timeout. Give
        // each HTTP attempt its own signal rather than retrying a stale one.
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    let response: Response;
    try {
      response = await perform();
    } catch (cause) {
      throw new GoogleCalendarIntegrationError(
        networkErrorCode,
        "Google Calendar request failed",
        { cause },
      );
    }
    if (response.status !== 401) return response;
    await refresh();
    try {
      return await perform();
    } catch (cause) {
      throw new GoogleCalendarIntegrationError(
        networkErrorCode,
        "Google Calendar retry failed after refreshing OAuth",
        { cause },
      );
    }
  };

  return { dependencies, bundle: sessionBundle, authorizedFetch, systemFallback, calendarId };
}

function validatedEventId(eventId: string): string {
  const normalized = eventId.trim();
  if (!/^[0-9a-v]{5,1024}$/u.test(normalized)) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "eventId must be a Google Calendar base32hex event ID",
    );
  }
  return normalized;
}

/**
 * Create and verify a client-visible founder-audit event.
 *
 * This function throws `GoogleCalendarIntegrationError` on every failure. A
 * caller must not advance the lead until it receives the typed receipt, which
 * proves Google persisted both the event and its unique Meet URL.
 */
export async function createFounderMeetingCalendarEvent(
  args: FounderMeetingCalendarRequest,
  dependencyOverrides: Partial<GoogleCalendarDependencies> = {},
): Promise<FounderMeetingCalendarReceipt> {
  const normalized = validateRequest(args);
  const { dependencies, bundle, authorizedFetch, systemFallback, calendarId: sessionCalendarId } =
    await openAuthorizedCalendarSession({
      tenantId: args.tenantId,
      organizerUserId: args.organizerUserId,
      expectedOrganizerEmail: args.expectedOrganizerEmail,
      dependencyOverrides,
    });

  const eventId = founderMeetingEventId(
    args.tenantId,
    args.organizerUserId,
    args.bookingRequestId,
  );
  const eventUrl = `${CALENDAR_API}/calendars/${encodeURIComponent(
    sessionCalendarId,
  )}/events/${eventId}`;
  const getEvent = async (
    code: "calendar_reconcile_failed" | "calendar_read_failed",
  ): Promise<GoogleCalendarEvent> => {
    const response = await authorizedFetch(eventUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    }, code);
    if (!response.ok) {
      throw new GoogleCalendarIntegrationError(
        code,
        `Google Calendar could not read event ${eventId}: ${await responseText(response)}`,
        { httpStatus: response.status, eventId },
      );
    }
    return responseJson<GoogleCalendarEvent>(response, code, eventId);
  };

  const insertUrl = new URL(
    `${CALENDAR_API}/calendars/${encodeURIComponent(sessionCalendarId)}/events`,
  );
  insertUrl.searchParams.set("conferenceDataVersion", "1");
  insertUrl.searchParams.set("sendUpdates", "all");

  // Workspace fallback: the workspace account is the organizer, so the human
  // host is invited explicitly — otherwise the booking would never reach the
  // person expected to run the call.
  const hostAttendeeEmail =
    systemFallback && args.expectedOrganizerEmail?.trim()
      ? args.expectedOrganizerEmail.trim().toLowerCase()
      : undefined;
  const attendees = founderMeetingInviteList({
    clientEmail: normalized.clientEmail,
    clientName: args.clientName,
    hostAttendeeEmail,
    openerEmail: args.openerEmail,
    openerDisplayName: args.openerDisplayName,
  });
  const expectedEvent: ExpectedFounderMeetingEvent = {
    eventId,
    startAt: normalized.startAt,
    endAt: normalized.endAt,
    clientEmail: normalized.clientEmail,
    attendeeEmails: attendees.map((attendee) => attendee.email),
    organizerEmail: bundle.gmail_address || undefined,
    summary: eventTitle(args.businessName),
    description: publicEventDescription(args.clientAgenda, normalized.website),
  };
  const eventPayload = {
    id: eventId,
    summary: expectedEvent.summary,
    description: expectedEvent.description,
    start: { dateTime: normalized.startAt, timeZone: normalized.timeZone },
    end: { dateTime: normalized.endAt, timeZone: normalized.timeZone },
    attendees,
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    conferenceData: {
      createRequest: {
        requestId: founderMeetingConferenceRequestId(
          args.tenantId,
          args.organizerUserId,
          args.bookingRequestId,
        ),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  let createResponse: Response;
  try {
    createResponse = await authorizedFetch(insertUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(eventPayload),
    }, "calendar_create_failed");
  } catch (error) {
    if (error instanceof GoogleCalendarIntegrationError) {
      throw new GoogleCalendarIntegrationError(
        error.code,
        error.detail,
        { httpStatus: error.httpStatus, eventId: error.eventId ?? eventId, cause: error },
      );
    }
    throw new GoogleCalendarIntegrationError(
      "calendar_create_failed",
      "Google Calendar event creation failed before a provider receipt was returned",
      { eventId, cause: error },
    );
  }

  let reconciled = false;
  let event: GoogleCalendarEvent;
  if (createResponse.status === 409) {
    reconciled = true;
    event = await getEvent("calendar_reconcile_failed");
  } else if (!createResponse.ok) {
    throw new GoogleCalendarIntegrationError(
      "calendar_create_failed",
      `Google Calendar event creation failed: ${await responseText(createResponse)}`,
      { httpStatus: createResponse.status, eventId },
    );
  } else {
    event = await responseJson<GoogleCalendarEvent>(
      createResponse,
      "calendar_create_failed",
      eventId,
    );
  }

  assertFounderMeetingEventIdentity(
    event,
    expectedEvent,
    reconciled ? "calendar_reconcile_failed" : "calendar_create_failed",
  );

  let meetUrl = extractMeetUrl(event);
  const pollAttempts = Math.max(0, Math.min(10, dependencies.pollAttempts));
  const pollIntervalMs = Math.max(0, Math.min(5_000, dependencies.pollIntervalMs));
  for (let attempt = 0; !meetUrl && attempt < pollAttempts; attempt += 1) {
    await dependencies.sleep(pollIntervalMs);
    event = await getEvent("calendar_read_failed");
    assertFounderMeetingEventIdentity(event, expectedEvent, "calendar_read_failed");
    meetUrl = extractMeetUrl(event);
  }
  if (!meetUrl) {
    throw new GoogleCalendarIntegrationError(
      "google_meet_link_missing",
      "Google created the Calendar event but did not provision its Meet link",
      { eventId },
    );
  }

  return {
    provider: "google_calendar",
    calendarId: sessionCalendarId,
    eventId,
    htmlUrl: event.htmlLink || "",
    meetUrl,
    iCalUID: event.iCalUID || "",
    status: event.status || "confirmed",
    organizerEmail: event.organizer?.email || bundle.gmail_address || "",
    startAt: event.start?.dateTime || normalized.startAt,
    endAt: event.end?.dateTime || normalized.endAt,
    timeZone: event.start?.timeZone || normalized.timeZone,
    reconciled,
  };
}

export function createGoogleFounderMeeting(
  input: CreateGoogleFounderMeetingInput,
): Promise<GoogleCalendarReceipt>;
export function createGoogleFounderMeeting(
  input: CreateGoogleFounderMeetingInput,
  dependencyOverrides: Partial<GoogleCalendarDependencies>,
): Promise<GoogleCalendarReceipt>;
export async function createGoogleFounderMeeting(
  input: CreateGoogleFounderMeetingInput,
  dependencyOverrides: Partial<GoogleCalendarDependencies> = {},
): Promise<GoogleCalendarReceipt> {
  if (typeof input.clientAgenda !== "string" || !input.clientAgenda.trim()) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "clientAgenda is required and must contain only client-visible context",
    );
  }

  const receipt = await createFounderMeetingCalendarEvent(
    {
      tenantId: input.tenantId,
      organizerUserId: input.hostUserId,
      expectedOrganizerEmail: input.expectedOrganizerEmail,
      bookingRequestId: input.requestId,
      startAt: input.meetingAt,
      timeZone: input.timezone,
      durationMinutes: input.durationMinutes,
      clientEmail: input.clientEmail,
      clientName: input.clientName,
      openerEmail: input.openerEmail,
      openerDisplayName: input.openerDisplayName,
      businessName: input.company,
      website: input.website,
      clientAgenda: input.clientAgenda,
    },
    dependencyOverrides,
  );

  if (!receipt.htmlUrl || !receipt.iCalUID || !receipt.organizerEmail) {
    throw new GoogleCalendarIntegrationError(
      "calendar_create_failed",
      "Google created an incomplete Calendar receipt",
      { eventId: receipt.eventId },
    );
  }

  return {
    calendarId: receipt.calendarId,
    eventId: receipt.eventId,
    htmlLink: receipt.htmlUrl,
    meetLink: receipt.meetUrl,
    iCalUID: receipt.iCalUID,
    organizerEmail: receipt.organizerEmail,
  };
}

export function updateGoogleFounderMeeting(
  input: UpdateGoogleFounderMeetingInput,
): Promise<GoogleCalendarReceipt>;
export function updateGoogleFounderMeeting(
  input: UpdateGoogleFounderMeetingInput,
  dependencyOverrides: Partial<GoogleCalendarDependencies>,
): Promise<GoogleCalendarReceipt>;
/**
 * Reschedule the existing founder audit and email the updated invite.
 * Conference data is intentionally omitted from the PATCH body so Google's
 * existing, unique Meet room is preserved instead of replaced.
 */
export async function updateGoogleFounderMeeting(
  input: UpdateGoogleFounderMeetingInput,
  dependencyOverrides: Partial<GoogleCalendarDependencies> = {},
): Promise<GoogleCalendarReceipt> {
  if (typeof input.clientAgenda !== "string" || !input.clientAgenda.trim()) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "clientAgenda is required and must contain only client-visible context",
    );
  }
  const eventId = validatedEventId(input.eventId);
  const normalized = validateRequest({
    tenantId: input.tenantId,
    organizerUserId: input.hostUserId,
    expectedOrganizerEmail: input.expectedOrganizerEmail,
    bookingRequestId: eventId,
    startAt: input.meetingAt,
    timeZone: input.timezone,
    durationMinutes: input.durationMinutes,
    clientEmail: input.clientEmail,
    clientName: input.clientName,
    openerEmail: input.openerEmail,
    openerDisplayName: input.openerDisplayName,
    businessName: input.company,
    website: input.website,
    clientAgenda: input.clientAgenda,
  });
  const { dependencies, bundle, authorizedFetch, systemFallback, calendarId: sessionCalendarId } =
    await openAuthorizedCalendarSession({
      tenantId: input.tenantId,
      organizerUserId: input.hostUserId,
      expectedOrganizerEmail: input.expectedOrganizerEmail,
      dependencyOverrides,
    });

  const eventUrl = `${CALENDAR_API}/calendars/${encodeURIComponent(
    sessionCalendarId,
  )}/events/${eventId}`;
  const patchUrl = new URL(eventUrl);
  patchUrl.searchParams.set("conferenceDataVersion", "1");
  patchUrl.searchParams.set("sendUpdates", "all");
  const hostAttendeeEmail =
    systemFallback && input.expectedOrganizerEmail?.trim()
      ? input.expectedOrganizerEmail.trim().toLowerCase()
      : undefined;
  const attendees = founderMeetingInviteList({
    clientEmail: normalized.clientEmail,
    clientName: input.clientName,
    hostAttendeeEmail,
    openerEmail: input.openerEmail,
    openerDisplayName: input.openerDisplayName,
  });
  const expectedEvent: ExpectedFounderMeetingEvent = {
    eventId,
    startAt: normalized.startAt,
    endAt: normalized.endAt,
    clientEmail: normalized.clientEmail,
    attendeeEmails: attendees.map((attendee) => attendee.email),
    organizerEmail: bundle.gmail_address || undefined,
    summary: eventTitle(input.company),
    description: publicEventDescription(input.clientAgenda, normalized.website),
  };
  const response = await authorizedFetch(
    patchUrl.toString(),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        summary: expectedEvent.summary,
        description: expectedEvent.description,
        start: { dateTime: normalized.startAt, timeZone: normalized.timeZone },
        end: { dateTime: normalized.endAt, timeZone: normalized.timeZone },
        attendees,
        guestsCanInviteOthers: false,
        guestsCanModify: false,
      }),
    },
    "calendar_update_failed",
  );
  if (!response.ok) {
    throw new GoogleCalendarIntegrationError(
      "calendar_update_failed",
      `Google Calendar event update failed: ${await responseText(response)}`,
      { httpStatus: response.status, eventId },
    );
  }

  let event = await responseJson<GoogleCalendarEvent>(
    response,
    "calendar_update_failed",
    eventId,
  );
  assertFounderMeetingEventIdentity(event, expectedEvent, "calendar_update_failed");

  const readEvent = async (): Promise<GoogleCalendarEvent> => {
    const readResponse = await authorizedFetch(
      eventUrl,
      { method: "GET", headers: { accept: "application/json" } },
      "calendar_read_failed",
    );
    if (!readResponse.ok) {
      throw new GoogleCalendarIntegrationError(
        "calendar_read_failed",
        `Google Calendar could not verify rescheduled event ${eventId}: ${await responseText(readResponse)}`,
        { httpStatus: readResponse.status, eventId },
      );
    }
    const verified = await responseJson<GoogleCalendarEvent>(
      readResponse,
      "calendar_read_failed",
      eventId,
    );
    assertFounderMeetingEventIdentity(verified, expectedEvent, "calendar_read_failed");
    return verified;
  };

  let meetLink = extractMeetUrl(event);
  const pollAttempts = Math.max(0, Math.min(10, dependencies.pollAttempts));
  const pollIntervalMs = Math.max(0, Math.min(5_000, dependencies.pollIntervalMs));
  for (let attempt = 0; !meetLink && attempt < pollAttempts; attempt += 1) {
    await dependencies.sleep(pollIntervalMs);
    event = await readEvent();
    meetLink = extractMeetUrl(event);
  }
  if (!meetLink) {
    throw new GoogleCalendarIntegrationError(
      "google_meet_link_missing",
      "Google updated the Calendar event but its existing Meet link could not be verified",
      { eventId },
    );
  }

  const htmlLink = event.htmlLink || "";
  const iCalUID = event.iCalUID || "";
  const organizerEmail = event.organizer?.email || bundle.gmail_address || "";
  if (!htmlLink || !iCalUID || !organizerEmail) {
    throw new GoogleCalendarIntegrationError(
      "calendar_update_failed",
      "Google returned an incomplete Calendar receipt after rescheduling",
      { eventId },
    );
  }
  return {
    calendarId: sessionCalendarId,
    eventId,
    htmlLink,
    meetLink,
    iCalUID,
    organizerEmail,
  };
}

export function cancelGoogleFounderMeeting(
  input: CancelGoogleFounderMeetingInput,
): Promise<void>;
export function cancelGoogleFounderMeeting(
  input: CancelGoogleFounderMeetingInput,
  dependencyOverrides: Partial<GoogleCalendarDependencies>,
): Promise<void>;
/** Cancel an audit invite; an already-absent/deleted event is a successful retry. */
export async function cancelGoogleFounderMeeting(
  input: CancelGoogleFounderMeetingInput,
  dependencyOverrides: Partial<GoogleCalendarDependencies> = {},
): Promise<void> {
  if (!input.tenantId.trim() || !input.hostUserId.trim()) {
    throw new GoogleCalendarIntegrationError(
      "invalid_request",
      "tenantId and hostUserId are required",
    );
  }
  const eventId = validatedEventId(input.eventId);
  const { authorizedFetch, calendarId: sessionCalendarId } = await openAuthorizedCalendarSession({
    tenantId: input.tenantId,
    organizerUserId: input.hostUserId,
    expectedOrganizerEmail: input.expectedOrganizerEmail,
    dependencyOverrides,
  });
  const deleteUrl = new URL(
    `${CALENDAR_API}/calendars/${encodeURIComponent(sessionCalendarId)}/events/${eventId}`,
  );
  deleteUrl.searchParams.set("sendUpdates", "all");
  const response = await authorizedFetch(
    deleteUrl.toString(),
    { method: "DELETE", headers: { accept: "application/json" } },
    "calendar_cancel_failed",
  );
  if (response.status === 404 || response.status === 410) return;
  if (!response.ok) {
    throw new GoogleCalendarIntegrationError(
      "calendar_cancel_failed",
      `Google Calendar event cancellation failed: ${await responseText(response)}`,
      { httpStatus: response.status, eventId },
    );
  }
}
