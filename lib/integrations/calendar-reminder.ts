/**
 * lib/integrations/calendar-reminder.ts — a rep's own follow-up reminders on
 * their own Google Calendar, so a callback reaches the phone in their pocket.
 *
 * THIS IS NOT THE FOUNDER-MEETING PATH, AND THE DIFFERENCE IS LOAD-BEARING.
 *
 * `createFounderMeetingCalendarEvent` books a CLIENT-VISIBLE audit: the client
 * is an attendee, a Meet link is minted, and that adapter deliberately refuses
 * to carry internal notes. A follow-up reminder is the opposite object. It is
 * private to the operator, it has NO attendees, it mints no conference link,
 * and it carries the operator's own call notes — which routinely say things
 * like "gatekeeper blocks before 10am, ask for Dana" that must never reach the
 * prospect. Adding an attendee here would mail that sentence to the lead.
 *
 * Three defences, because one is a single point of failure:
 *   1. no `attendees` key is ever constructed;
 *   2. `visibility: "private"`;
 *   3. `sendUpdates=none` on every request, so even a future edit that
 *      reintroduced an attendee would not mail them.
 * `tests/calendar-reminder.test.ts` pins all three.
 *
 * WHY THE EVENT ID IS STORED RATHER THAN DERIVED.
 *
 * An earlier implementation of this idea (oasis PR #284) derived a
 * deterministic event id from the lead so nothing had to be persisted. Six
 * consecutive review rounds each found a different defect in it: PUT-only 404s
 * on first write, 410 against a cancelled tombstone, a fresh insert nothing
 * could address, 409 on reinserting a tombstoned id, an unverifiable "revive",
 * and a swallowed write-back that left a live reminder no code could clear.
 * Every one had the same root: once an event with a caller-supplied id is
 * deleted, that id is ambiguous forever, and Google's 404/409/410 behaviour
 * across live events, retained tombstones and freed ids cannot be verified
 * from here. Remembering the id GOOGLE assigns removes the question, because
 * Google never reuses one. The caller must persist `eventId` from the result.
 *
 * NOTHING HERE THROWS. A calendar problem must never fail a note that was
 * genuinely written, and must never be reported as success either. Every path
 * returns a typed result the caller surfaces and, when retryable, queues.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  CALENDAR_API,
  openAuthorizedCalendarSession,
  GoogleCalendarIntegrationError,
  type AuthorizedCalendarFetch,
  type GoogleCalendarErrorCode,
} from "./google-calendar";
import {
  isDwdConfigured,
  mintDelegatedAccessToken,
  clearDelegatedTokenCache,
  type DwdTokenResult,
} from "./google-dwd";

/** Impersonated, "primary" is the rep's OWN calendar. That is the whole point. */
const PRIMARY_CALENDAR_ID = "primary";

/**
 * The slice of an authorized session this module needs.
 *
 * Injectable so the tests can exercise the real request-building and the real
 * status handling against a scripted Google, rather than asserting that some
 * string appears in this file. A test that only pins source text cannot tell a
 * safe refactor from a removed protection: it goes red on the first and stays
 * green on the second.
 */
export type ReminderSession = {
  authorizedFetch: AuthorizedCalendarFetch;
  calendarId: string;
  /** True when the session runs on the shared workspace identity. Always refused here. */
  systemFallback?: boolean;
};

export type ReminderDeps = {
  /** Returns null to mean "this operator has no usable personal grant". */
  openSession?: (tenantId: string, userId: string) => Promise<ReminderSession | null>;
  /** Test seam: resolve the operator's work address for delegation. */
  resolveOperatorEmail?: (tenantId: string, userId: string) => Promise<string | null>;
  /** Test seam: mint a delegated access token for that address. */
  mintDelegatedToken?: (email: string) => Promise<DwdTokenResult>;
  /** Test seam: the fetch the delegated session uses. */
  fetchImpl?: typeof fetch;
};

/**
 * Resolve the address a delegated token should act as.
 *
 * `user_profiles.auth_user_id` is the same id the session and the integration
 * store key on, and `.email` is the work address the Workspace knows. If we
 * cannot find it, delegation is skipped rather than guessed at: minting a
 * token for the wrong person would put one rep's leads on another rep's phone.
 */
async function resolveOperatorEmail(tenantId: string, userId: string): Promise<string | null> {
  try {
    const db = getServiceSupabase();
    const row = await db
      .from("user_profiles")
      .select("email")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (row.error) return null;
    const email = (row.data as { email?: string | null } | null)?.email;
    return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * A session that acts as the operator via domain-wide delegation.
 *
 * Returns null when delegation is not configured, the address is not on an
 * authorised domain, or the mint failed — every one of which means "fall back
 * to refusing", never "use somebody else's calendar".
 *
 * `calendarId` is "primary" and that is the point: while impersonating, primary
 * IS this rep's own calendar, so the reminder reaches their own phone. This is
 * the difference between delegation (correct) and the shared workspace
 * calendar this module refuses above (wrong for a private reminder).
 */
async function openDelegatedSession(
  tenantId: string,
  userId: string,
  deps?: ReminderDeps,
): Promise<ReminderSession | null> {
  if (!deps?.mintDelegatedToken && !isDwdConfigured()) return null;

  const resolve = deps?.resolveOperatorEmail || resolveOperatorEmail;
  const email = await resolve(tenantId, userId);
  if (!email) return null;

  const mint = deps?.mintDelegatedToken || mintDelegatedAccessToken;
  let minted = await mint(email);
  if (!minted.ok) {
    // A TIMEOUT IS NOT A DISCONNECTED ACCOUNT, AND FLATTENING THE TWO COSTS
    // THE REMINDER.
    //
    // Returning null for every mint failure sends all of them to
    // `not_connected`, which the follow-up worker classifies as BLOCKED and
    // never retries. For a rep whose calendar comes from delegation, a 429 or a
    // 5xx at Google's token endpoint would then permanently kill that
    // reminder -- the exact blocked-vs-failed inversion this module is careful
    // about everywhere else. Transport failures must stay retryable so the
    // cron picks them up; only the ones a person has to fix fall through to a
    // refusal. (Codex review, 2026-08-26.)
    if (minted.reason === "retryable") {
      throw new GoogleCalendarIntegrationError("calendar_read_failed", minted.detail);
    }
    return null;
  }
  let accessToken = minted.accessToken;

  const fetchImpl = deps?.fetchImpl || fetch;
  const authorizedFetch: AuthorizedCalendarFetch = async (url, init, networkErrorCode) => {
    const perform = () =>
      fetchImpl(url, {
        ...init,
        headers: { ...(init.headers || {}), authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(
          init.method === "POST" || init.method === "PATCH" ? 20_000 : 15_000,
        ),
      });
    let response: Response;
    try {
      response = await perform();
    } catch (cause) {
      throw new GoogleCalendarIntegrationError(code(networkErrorCode), "delegated request failed", {
        cause,
      });
    }
    if (response.status !== 401) return response;
    // The cached token went stale. Re-mint once, exactly like the personal
    // path does, rather than surfacing a 401 the caller would read as a
    // revoked grant needing a human.
    clearDelegatedTokenCache();
    minted = await mint(email);
    if (!minted.ok) {
      // Same distinction on the refresh path. Handing back the 401 would have
      // it read as a revoked grant needing a human, when Google's token
      // endpoint was merely unreachable for a moment.
      if (minted.reason === "retryable") {
        throw new GoogleCalendarIntegrationError(code(networkErrorCode), minted.detail);
      }
      return response;
    }
    accessToken = minted.accessToken;
    try {
      return await perform();
    } catch (cause) {
      throw new GoogleCalendarIntegrationError(
        code(networkErrorCode),
        "delegated retry failed after re-minting",
        { cause },
      );
    }
  };

  return { authorizedFetch, calendarId: PRIMARY_CALENDAR_ID, systemFallback: false };
}

/** Identity helper so the network-error code passes through unchanged. */
function code(value: GoogleCalendarErrorCode): GoogleCalendarErrorCode {
  return value;
}

async function openSession(
  tenantId: string,
  userId: string,
  deps?: ReminderDeps,
): Promise<ReminderSession> {
  if (deps?.openSession) {
    const injected = await deps.openSession(tenantId, userId);
    // A null injected session means "no personal grant", which must fall
    // through to delegation exactly like the real path does -- otherwise the
    // test seam would exercise a flow production never takes.
    if (injected) return assertNotSharedCalendar(injected);
    const delegatedOnly = await openDelegatedSession(tenantId, userId, deps);
    if (delegatedOnly) return delegatedOnly;
    throw new GoogleCalendarIntegrationError(
      "google_calendar_not_connected",
      "no personal Google connection and no domain-wide delegation for this operator",
    );
  }

  // 1. THE REP'S OWN GRANT WINS. If they clicked Connect, that consent is the
  //    most direct answer and needs no admin configuration at all.
  let personalError: unknown = null;
  try {
    const s = await openAuthorizedCalendarSession({ tenantId, organizerUserId: userId });
    if (!s.systemFallback) {
      return { authorizedFetch: s.authorizedFetch, calendarId: s.calendarId, systemFallback: false };
    }
    // systemFallback means there was no usable personal grant. Fall through to
    // delegation rather than writing to the shared calendar.
  } catch (error) {
    personalError = error;
  }

  // 2. DOMAIN-WIDE DELEGATION. Acts AS this rep, so the reminder still lands on
  //    their own calendar and their own phone, with nothing for them to click.
  const delegated = await openDelegatedSession(tenantId, userId, deps);
  if (delegated) return delegated;

  // 3. Neither route is available. Preserve the personal path's own diagnosis
  //    when it had one, so "scope required" does not get flattened into
  //    "not connected" and send a rep to the wrong fix.
  if (personalError) throw personalError;
  throw new GoogleCalendarIntegrationError(
    "google_calendar_not_connected",
    "no personal Google connection and no domain-wide delegation for this operator",
  );
}

/** REFUSE THE WORKSPACE FALLBACK. */
function assertNotSharedCalendar(session: ReminderSession): ReminderSession {
  // REFUSE THE WORKSPACE FALLBACK. THIS IS NOT AN OPTIMISATION, IT IS A LEAK.
  //
  // `openAuthorizedCalendarSession` falls back to the shared OASIS workspace
  // identity when an operator has no personal work-OAuth grant. For a founder
  // audit that is exactly right: the workspace hosts the meeting and the client
  // is invited either way. For a PRIVATE REMINDER it is wrong twice over.
  //
  //   1. It would write the operator's own call notes ("gatekeeper blocks
  //      before 10am, ask for Dana") onto a calendar the whole workspace can
  //      read. The note is the payload here, not an incidental field.
  //   2. It would not reach the phone in their pocket, which is the entire
  //      point of the feature, so it would look like it worked and quietly do
  //      nothing useful.
  //
  // A fallback that produces a plausible wrong answer is worse than a refusal.
  // `not_connected` is honest and actionable: it tells this operator to connect
  // their own Google account, which is the only thing that can actually work.
  if (session.systemFallback) {
    throw new GoogleCalendarIntegrationError(
      "google_calendar_not_connected",
      "a reminder is private to one operator and cannot be hosted on the shared workspace calendar",
    );
  }

  return { authorizedFetch: session.authorizedFetch, calendarId: session.calendarId };
}

/** Longest note text we will put on a calendar event. */
const MAX_DESCRIPTION_CHARS = 4000;
const DEFAULT_DURATION_MINUTES = 15;
const DEFAULT_REMINDER_MINUTES = 10;

/**
 * Why a reminder did not reach Google.
 *
 * The split is the BLOCKED-vs-FAILED distinction, and the retry worker keys off
 * it: `retryable` conditions are transport-shaped and a later attempt may well
 * succeed, so they queue. Everything else needs a PERSON to act — connect an
 * account, re-grant a scope, fix a malformed time — and retrying it on a timer
 * burns quota forever while never once fixing the cause, then pages about it.
 */
export type ReminderFailure =
  /** The operator has never connected a work Google account. Normal, not an error. */
  | "not_connected"
  /** Connected, but the grant lacks calendar.events. Needs a re-consent. */
  | "scope_required"
  /** Google rejected our credentials outright (revoked/expired refresh token). */
  | "auth_failed"
  /** Network error, timeout, 429, or 5xx. A later attempt may succeed. */
  | "retryable"
  /** Google refused the request itself (4xx). Retrying sends the same bad request. */
  | "rejected";

/** Conditions a retry can plausibly clear. Everything else waits on a human. */
export function isRetryableFailure(reason: ReminderFailure): boolean {
  return reason === "retryable";
}

export type ReminderWriteResult =
  | { ok: true; eventId: string; htmlLink: string | null; recreated: boolean }
  | { ok: false; reason: ReminderFailure; detail: string };

export type ReminderVoidResult =
  | { ok: true }
  | { ok: false; reason: ReminderFailure; detail: string };

export type ReminderEventInput = {
  /** Lock-screen text. Business name first: it is read at arm's length in about a second. */
  summary: string;
  /** Operator-private context. Never shown to the lead — this event has no attendees. */
  description: string;
  /** Absolute ISO instant the reminder fires for. */
  startAt: string;
  /** IANA zone for display. Optional; the instant is already absolute. */
  timeZone?: string;
  durationMinutes?: number;
  reminderMinutes?: number;
};

function classifyError(error: unknown): { reason: ReminderFailure; detail: string } {
  if (error instanceof GoogleCalendarIntegrationError) {
    switch (error.code) {
      case "google_calendar_not_connected":
        return { reason: "not_connected", detail: error.detail };
      case "calendar_scope_required":
        return { reason: "scope_required", detail: error.detail };
      case "token_refresh_failed":
        return { reason: "auth_failed", detail: error.detail };
      case "google_oauth_config_missing":
        // A missing client id/secret is deployment configuration, not transport.
        return { reason: "auth_failed", detail: error.detail };
      case "invalid_request":
      case "calendar_organizer_mismatch":
        return { reason: "rejected", detail: error.detail };
      default:
        // Network/timeout errors arrive as calendar_*_failed with a cause.
        return { reason: "retryable", detail: error.detail };
    }
  }
  return {
    reason: "retryable",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * HTTP status -> failure class.
 *
 * 401 is deliberately NOT retryable here: `authorizedFetch` already refreshed
 * the token and retried once before we ever see a 401, so a second one means
 * the grant itself is gone. Queueing that would retry a revoked token on a
 * timer until someone reconnects, which is exactly the alert-storm shape.
 */
function classifyStatus(status: number, body: string): { reason: ReminderFailure; detail: string } {
  if (status === 401) return { reason: "auth_failed", detail: `google_401 ${body}`.trim() };
  if (status === 403) {
    // 403 is overloaded: quota/rate limits are transient, permission is not.
    const transient = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError/i.test(body);
    return transient
      ? { reason: "retryable", detail: `google_403 ${body}`.trim() }
      : { reason: "scope_required", detail: `google_403 ${body}`.trim() };
  }
  if (status === 429 || status >= 500) {
    return { reason: "retryable", detail: `google_${status} ${body}`.trim() };
  }
  return { reason: "rejected", detail: `google_${status} ${body}`.trim() };
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * The event body.
 *
 * Note the shape of what is ABSENT: no `attendees`, no `conferenceData`. This
 * function is the only place a reminder event body is constructed, so those
 * two omissions are the whole privacy guarantee and a test asserts on them.
 */
function reminderEventBody(input: ReminderEventInput): Record<string, unknown> {
  const startMs = Date.parse(input.startAt);
  const durationMinutes = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const reminderMinutes = input.reminderMinutes ?? DEFAULT_REMINDER_MINUTES;
  const endMs = startMs + durationMinutes * 60_000;
  return {
    summary: input.summary.slice(0, 250),
    description: input.description.slice(0, MAX_DESCRIPTION_CHARS),
    start: {
      dateTime: new Date(startMs).toISOString(),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    },
    end: {
      dateTime: new Date(endMs).toISOString(),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    },
    visibility: "private",
    transparency: "opaque",
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: reminderMinutes }],
    },
  };
}

function validateInput(input: ReminderEventInput): string | null {
  if (!input.summary.trim()) return "summary is required";
  const startMs = Date.parse(input.startAt);
  if (!Number.isFinite(startMs)) return `startAt is not a valid instant: ${input.startAt}`;
  const duration = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  if (!Number.isFinite(duration) || duration <= 0) return "durationMinutes must be positive";
  const remind = input.reminderMinutes ?? DEFAULT_REMINDER_MINUTES;
  if (!Number.isFinite(remind) || remind < 0) return "reminderMinutes must be zero or positive";
  return null;
}

/**
 * Create or move the operator's reminder for one lead.
 *
 * Pass the id stored from last time, or null if this lead has never had one.
 * `recreated: true` means the stored id was dead (deleted from the operator's
 * own calendar) and a NEW event replaced it — the caller must persist the new
 * id, or the next clear will address a corpse and silently leave a live alert.
 */
export async function writeReminderEvent(
  tenantId: string,
  userId: string,
  existingEventId: string | null,
  input: ReminderEventInput,
  deps?: ReminderDeps,
): Promise<ReminderWriteResult> {
  const invalid = validateInput(input);
  if (invalid) return { ok: false, reason: "rejected", detail: invalid };

  let session: ReminderSession;
  try {
    session = await openSession(tenantId, userId, deps);
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  }

  const { authorizedFetch, calendarId } = session;
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const body = reminderEventBody(input);

  const insert = async (recreated: boolean): Promise<ReminderWriteResult> => {
    let response: Response;
    try {
      response = await authorizedFetch(
        `${base}?sendUpdates=none`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        "calendar_create_failed",
      );
    } catch (error) {
      return { ok: false, ...classifyError(error) };
    }
    if (!response.ok) {
      return { ok: false, ...classifyStatus(response.status, await readBody(response)) };
    }
    let created: { id?: string; htmlLink?: string };
    try {
      created = (await response.json()) as { id?: string; htmlLink?: string };
    } catch (error) {
      return { ok: false, ...classifyError(error) };
    }
    if (!created.id) {
      // Google accepted the write but told us nothing we can address later.
      // Treat as retryable rather than inventing an id: a duplicate reminder is
      // recoverable, an unaddressable one is not.
      return { ok: false, reason: "retryable", detail: "google returned no event id" };
    }
    return { ok: true, eventId: created.id, htmlLink: created.htmlLink || null, recreated };
  };

  if (!existingEventId) return insert(false);

  let response: Response;
  try {
    response = await authorizedFetch(
      `${base}/${encodeURIComponent(existingEventId)}?sendUpdates=none`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      "calendar_update_failed",
    );
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  }

  // 404 = never existed or the id was freed. 410 = cancelled tombstone.
  // Both mean the stored id is dead. Do NOT try to revive or reuse it (that
  // was defects 4 and 5 of six); create a fresh event and hand back its id.
  if (response.status === 404 || response.status === 410) {
    return insert(true);
  }
  if (!response.ok) {
    return { ok: false, ...classifyStatus(response.status, await readBody(response)) };
  }
  let updated: { id?: string; htmlLink?: string };
  try {
    updated = (await response.json()) as { id?: string; htmlLink?: string };
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  }
  return {
    ok: true,
    eventId: updated.id || existingEventId,
    htmlLink: updated.htmlLink || null,
    recreated: false,
  };
}

/**
 * Delete the operator's reminder.
 *
 * A 404/410 counts as success: the desired end state is "no reminder", and it
 * is already true. Reporting that as a failure would make callers retry a
 * deletion that has nothing left to delete.
 */
export async function removeReminderEvent(
  tenantId: string,
  userId: string,
  eventId: string | null,
  deps?: ReminderDeps,
): Promise<ReminderVoidResult> {
  if (!eventId) return { ok: true };

  let session: ReminderSession;
  try {
    session = await openSession(tenantId, userId, deps);
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  }

  const { authorizedFetch, calendarId } = session;
  let response: Response;
  try {
    response = await authorizedFetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      { method: "DELETE" },
      "calendar_cancel_failed",
    );
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  }
  if (response.ok || response.status === 404 || response.status === 410) return { ok: true };
  return { ok: false, ...classifyStatus(response.status, await readBody(response)) };
}
