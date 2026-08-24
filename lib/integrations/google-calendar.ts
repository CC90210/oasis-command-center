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
  /**
   * Stable de-duplication key. Google treats event ids as unique per calendar,
   * so re-sending the same id UPDATES the event instead of creating a second
   * one. This is what makes a retry safe: a rep who changes a callback time
   * twice ends up with one event at the latest time, not three.
   *
   * Google requires ids to be base32hex (lowercase a-v and 0-9), 5-1024 chars,
   * so callers should pass raw text and let encodeEventId below normalise it.
   */
  idempotencyKey?: string;
  /** Minutes before the event to pop a reminder. */
  reminderMinutes?: number;
};

/**
 * Google event ids accept only lowercase a-v and digits 0-9. A UUID contains
 * w/x/y/z and hyphens, and a lead id may contain anything at all, so a raw
 * value is rejected by the API with a 400 that reads like a bug in the caller.
 *
 * This maps arbitrary text into the legal alphabet deterministically -- the
 * same input always yields the same id, which is the entire point: that is what
 * makes a repeated push an update rather than a duplicate event.
 */
export function encodeEventId(raw: string): string {
  const ALPHABET = "0123456789abcdefghijklmnopqrstuv";
  let out = "";
  for (const ch of Buffer.from(raw, "utf8")) {
    out += ALPHABET[ch >> 5] + ALPHABET[ch & 31];
  }
  // 5 char minimum, 1024 maximum.
  return out.slice(0, 1024).padEnd(5, "0");
}

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
 * Create or update an event on this user's primary calendar.
 *
 * UPSERT, NOT INSERT. When `idempotencyKey` is supplied this issues a PUT to a
 * deterministic event id, so calling it repeatedly for the same callback
 * converges on ONE event at the latest time. An insert-only implementation
 * would litter a rep's phone with every superseded callback time, and the rep
 * would learn to ignore the calendar -- which costs the whole feature.
 *
 * `sendUpdates=none` on the write: this is the rep's own working calendar, and
 * emailing a prospect an invite they never agreed to is a different decision
 * with consent implications. Callers that genuinely need to invite an external
 * attendee must pass attendees explicitly AND own that decision.
 */
export async function upsertCalendarEvent(
  tenantId: string,
  userId: string,
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

  const eventId = input.idempotencyKey ? encodeEventId(input.idempotencyKey) : null;

  const collection = `${CALENDAR_API}/calendars/primary/events?sendUpdates=none`;
  const single = eventId
    ? `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`
    : null;

  const send = async (url: string, method: "POST" | "PUT", payload: Record<string, unknown>) => {
    const r = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
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
    // INSERT FIRST, THEN UPDATE ON CONFLICT.
    //
    // This was a PUT-only path and it was broken for every FIRST push
    // (Codex review, 2026-08-24). Google's events.update only updates an
    // EXISTING event: a PUT to a deterministic id that has never been created
    // returns 404. Since every callback carries an idempotency key, the very
    // first sync for every lead would have failed, the rep would have been
    // told their calendar could not be reached, and the feature would never
    // have worked once -- while every unit test passed, because none of them
    // exercise the HTTP call.
    //
    // events.insert DOES accept a caller-supplied `id`, and answers 409 when
    // that id already exists. So: insert, and on 409 fall back to update. That
    // preserves the property the key exists for -- one event per lead,
    // rescheduling moves it rather than adding a second reminder.
    if (!eventId || !single) {
      const r = await send(collection, "POST", body);
      if (!r.ok || !r.body.id) {
        return { ok: false, reason: "api_error", detail: r.body.error?.message || `HTTP ${r.status}` };
      }
      return { ok: true, eventId: r.body.id, htmlLink: r.body.htmlLink || null };
    }

    const created = await send(collection, "POST", { ...body, id: eventId });
    if (created.ok && created.body.id) {
      return { ok: true, eventId: created.body.id, htmlLink: created.body.htmlLink || null };
    }
    // 409 means this lead already has its event: update it in place. Any other
    // status is a real failure and must not be retried as an update, or a
    // genuine auth/quota error would be reported as a mysterious 404.
    if (created.status !== 409) {
      return { ok: false, reason: "api_error", detail: created.body.error?.message || `HTTP ${created.status}` };
    }
    const updated = await send(single, "PUT", { ...body, id: eventId });
    if (!updated.ok || !updated.body.id) {
      return { ok: false, reason: "api_error", detail: updated.body.error?.message || `HTTP ${updated.status}` };
    }
    return { ok: true, eventId: updated.body.id, htmlLink: updated.body.htmlLink || null };
  } catch (err) {
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove an event this system created. Used when a callback is superseded by a
 * terminal disposition -- a prospect who said never call again must not have a
 * reminder waiting on the rep's phone.
 *
 * A 404/410 counts as SUCCESS: the desired end state is "no event", and an
 * already-absent event satisfies it. Treating that as a failure would make an
 * ordinary retry look broken.
 */
export async function deleteCalendarEvent(
  tenantId: string,
  userId: string,
  idempotencyKey: string,
): Promise<CalendarVoidResult> {
  const auth = await accessTokenFor(tenantId, userId);
  if (!auth.ok) return auth;

  const eventId = encodeEventId(idempotencyKey);
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
