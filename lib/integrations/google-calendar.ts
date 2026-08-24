/**
 * lib/integrations/google-calendar.ts — writing events to a user's own Google
 * Calendar.
 *
 * WHY GOOGLE CALENDAR AND NOT AN IN-APP CALENDAR (operator decision, Adon
 * 2026-08-23): "I just want everyone to be able to have it on their phone so I
 * can send them calls." A rep's phone already syncs their Google Calendar, with
 * notifications, offline, on the lock screen. An in-app calendar would need a
 * mobile app, push infrastructure, and a habit nobody has. This writes into the
 * tool reps already carry.
 *
 * WHAT THIS IS NOT. It is not the source of truth. `next_action_at` on the lead
 * is. The calendar is a MIRROR, pushed after the lead write succeeds, and every
 * function here is designed so that a calendar failure degrades the feature to
 * "the callback is in your queue but not on your phone" rather than losing the
 * callback. A rep with no Google connection still gets a fully working queue.
 * See pushNextActionToCalendar in lib/web-leads/calendar-sync.ts for the seam
 * that enforces that ordering.
 *
 * EVERY RESULT IS EXPLICIT. No function here returns a bare boolean or
 * swallows an error, because the failure that matters most in this feature is
 * the quiet one: a meeting shown as booked that never reached anyone's
 * calendar. Callers get a discriminated union and must decide what to say. The
 * three outcomes are deliberately distinct:
 *
 *   { ok: true, ... }              the event exists, Google returned its id
 *   { ok: false, reason: "not_connected" }
 *                                  this user has not linked Google. A human
 *                                  must act. NOT an error, and never retried.
 *   { ok: false, reason: ... }     a real failure. Retryable, and the caller
 *                                  must not claim success.
 *
 * "not_connected" being separate from "failed" is the BLOCKED-versus-FAILED
 * distinction: a missing credential is a person's job to fix, and a retry loop
 * around it just generates noise forever.
 *
 * TOKENS. Reuses the same per-user encrypted bundle store the Gmail connect
 * uses (user_integration_credentials via lib/user-integration-store.ts), under
 * service `google_calendar`, so a rep connects Calendar independently of any
 * mailbox and either can be revoked alone.
 */

import { getUserIntegrationBundle, setUserIntegrationValue } from "@/lib/user-integration-store";

export const GOOGLE_CALENDAR_SERVICE = "google_calendar";

/** The one scope this feature needs. `calendar.events` can create and update
 *  events but cannot delete a calendar, read the user's other calendars' ACLs,
 *  or touch anything else in their Google account. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/** Refresh a little early. A token that expires mid-request produces a 401 the
 *  caller would report as a failed booking. */
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 15_000;

export type CalendarFailure =
  | "not_connected"
  | "not_configured"
  | "token_refresh_failed"
  | "api_error"
  | "network_error";

export type CalendarResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: CalendarFailure; detail?: string };

/** For operations whose success carries no payload. `CalendarResult<{}>`
 *  cannot express this: intersecting `{ ok: true }` with an empty-object
 *  type makes `ok` unassignable. */
export type CalendarVoidResult =
  | { ok: true }
  | { ok: false; reason: CalendarFailure; detail?: string };

export type CalendarEventInput = {
  /** Short title. Shows on the phone's lock screen, so it must name the
   *  business, not the internal record. */
  summary: string;
  description?: string;
  /** ISO instant. */
  startAt: string;
  /** ISO instant. When absent, defaults to startAt + defaultMinutes. */
  endAt?: string;
  defaultMinutes?: number;
  location?: string;
  /** Additional invitees. The connected user is the organizer and does not
   *  need to be listed. */
  attendeeEmails?: string[];
  /** Minutes before the event to pop a reminder. */
  reminderMinutes?: number;
};

/**
 * A fresh access token for this user's calendar, refreshing and persisting if
 * stale. Distinguishes "never connected" from "connection broken" because the
 * caller must say different things to the rep: one is "connect Google", the
 * other is "reconnect Google, your access was revoked".
 */
async function accessTokenFor(
  tenantId: string,
  userId: string,
): Promise<CalendarResult<{ token: string }>> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, reason: "not_configured", detail: "GOOGLE_CLIENT_ID/SECRET not set" };
  }

  const bundle = await getUserIntegrationBundle(tenantId, userId, GOOGLE_CALENDAR_SERVICE);
  if (!bundle || !bundle.refresh_token) {
    return { ok: false, reason: "not_connected" };
  }

  const expiresAt = bundle.expires_at ? Date.parse(bundle.expires_at) : 0;
  if (bundle.access_token && expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return { ok: true, token: bundle.access_token };
  }

  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: bundle.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (j.error || !j.access_token) {
      // invalid_grant means the user revoked access or changed their password.
      // That is a human action, not a transient fault, so it is reported as
      // "reconnect" rather than retried.
      return { ok: false, reason: "token_refresh_failed", detail: j.error || "no access_token" };
    }
    const newExpiry = new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
    await setUserIntegrationValue(tenantId, userId, GOOGLE_CALENDAR_SERVICE, "access_token", j.access_token);
    await setUserIntegrationValue(tenantId, userId, GOOGLE_CALENDAR_SERVICE, "expires_at", newExpiry);
    return { ok: true, token: j.access_token };
  } catch (err) {
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Has this user connected their Google Calendar?
 *
 * Cheap, and deliberately NOT proof that a write will succeed -- a stored
 * refresh token can still be revoked. Use it to decide what to OFFER a rep
 * ("Connect Google Calendar" vs "Book meeting"), never to report that a
 * meeting was booked. Only a real event id proves that.
 */
export async function isCalendarConnected(tenantId: string, userId: string): Promise<boolean> {
  const bundle = await getUserIntegrationBundle(tenantId, userId, GOOGLE_CALENDAR_SERVICE);
  return Boolean(bundle?.refresh_token);
}

/** The Google account this calendar belongs to, for showing a rep WHICH
 *  calendar their callbacks are going to. Null when not connected. */
export async function connectedCalendarAddress(tenantId: string, userId: string): Promise<string | null> {
  const bundle = await getUserIntegrationBundle(tenantId, userId, GOOGLE_CALENDAR_SERVICE);
  return bundle?.google_address || null;
}

/**
 * Write this user's reminder event, creating it if we have never made one.
 *
 * GOOGLE ASSIGNS THE ID; WE REMEMBER IT. `existingEventId` is whatever we
 * stored last time, or null. On success the caller MUST persist the returned
 * id, because that is the only handle this system will ever have on the event.
 *
 * WHY IT WORKS THIS WAY, AND IT IS THE FIFTH ATTEMPT. Earlier versions derived
 * a DETERMINISTIC id from the lead so no storage was needed. Five consecutive
 * review rounds each found a defect in that approach, and every one had the
 * same root: once an event with a caller-supplied id is deleted or cancelled,
 * that id is ambiguous forever. It may name a live event, a retained tombstone
 * with deletion semantics, or nothing, and Google answers 409/410/404 across
 * those combinations in ways this codebase CANNOT VERIFY without a live
 * account. Each patch guessed at one arm and broke another:
 *
 *   PUT-only                   404 on every first push
 *   insert-then-update         410 against a cancelled tombstone
 *   fall back to fresh insert  produced an event nothing could address
 *   reinsert with same id      409 against a tombstone still holding it
 *   revive via "confirmed"     cancelled single events may not be revivable
 *
 * Storing the id Google hands back removes the entire question. We never
 * reuse an id after removing an event, never depend on tombstone behaviour,
 * and every branch is one this code can actually reason about:
 *
 *   no stored id            -> plain insert, remember what comes back
 *   stored id, update ok    -> done
 *   stored id, 404/410      -> that event is gone; insert a fresh one and
 *                              remember the new id
 *
 * The one cost is a small write-back per push, and a failed write-back is
 * recoverable (at worst one orphaned event and a duplicate next time) rather
 * than a reminder that can never be scheduled again.
 */
export async function writeReminderEvent(
  tenantId: string,
  userId: string,
  existingEventId: string | null,
  input: CalendarEventInput,
): Promise<CalendarResult<{ eventId: string; htmlLink: string | null }>> {
  const auth = await accessTokenFor(tenantId, userId);
  if (!auth.ok) return auth;

  const startMs = Date.parse(input.startAt);
  if (!Number.isFinite(startMs)) {
    return { ok: false, reason: "api_error", detail: "start time is not a valid instant" };
  }
  const endAt = input.endAt && Number.isFinite(Date.parse(input.endAt))
    ? input.endAt
    : new Date(startMs + (input.defaultMinutes || 30) * 60_000).toISOString();

  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description || undefined,
    location: input.location || undefined,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: endAt },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: input.reminderMinutes ?? 10 }],
    },
  };
  if (input.attendeeEmails?.length) {
    body.attendees = input.attendeeEmails.map((email) => ({ email }));
  }

  const collection = `${CALENDAR_API}/calendars/primary/events?sendUpdates=none`;

  const send = async (url: string, method: "POST" | "PUT") => {
    const r = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => ({}))) as {
      id?: string;
      htmlLink?: string;
      error?: { message?: string };
    };
    return { status: r.status, ok: r.ok, body: j };
  };

  try {
    if (existingEventId) {
      const updated = await send(
        `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(existingEventId)}?sendUpdates=none`,
        "PUT",
      );
      if (updated.ok && updated.body.id) {
        return { ok: true, eventId: updated.body.id, htmlLink: updated.body.htmlLink || null };
      }
      // Anything other than "it is gone" is a real failure and must be
      // reported, not papered over by silently creating a second event.
      if (updated.status !== 404 && updated.status !== 410) {
        return { ok: false, reason: "api_error", detail: updated.body.error?.message || `HTTP ${updated.status}` };
      }
      // 404/410: the rep deleted it by hand, or we removed it. Fall through and
      // make a new one. No id is reused, so no tombstone question arises.
    }

    const created = await send(collection, "POST");
    if (!created.ok || !created.body.id) {
      return { ok: false, reason: "api_error", detail: created.body.error?.message || `HTTP ${created.status}` };
    }
    return { ok: true, eventId: created.body.id, htmlLink: created.body.htmlLink || null };
  } catch (err) {
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Take this user's reminder off their calendar.
 *
 * Addressed by the id we STORED, never by a derived one, so there is no
 * question about what it names. A 404/410 means it is already gone, which is
 * the end state we wanted, so both are success -- as is being asked to remove
 * a reminder that was never created.
 */
export async function removeReminderEvent(
  tenantId: string,
  userId: string,
  eventId: string | null,
): Promise<CalendarVoidResult> {
  if (!eventId) return { ok: true };

  const auth = await accessTokenFor(tenantId, userId);
  if (!auth.ok) return auth;

  try {
    const r = await fetch(
      `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (r.ok || r.status === 404 || r.status === 410) return { ok: true };
    return { ok: false, reason: "api_error", detail: `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }
}
