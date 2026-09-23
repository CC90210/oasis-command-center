/**
 * lib/integrations/google-token-probe.ts — is this Google refresh credential
 * still spendable? One implementation, because there is exactly one right
 * answer and more than one caller.
 *
 * WHY THIS EXISTS. The 2026-08-26 outage was caused, in the operator's words,
 * by "the readiness check and the booking asking different questions": the
 * handoff banner tested that a credential STRING EXISTED while the booking
 * tested whether Google would honour it. Two askers, two answers, one green
 * banner over a dead credential.
 *
 * By 2026-08-27 there were about to be three. The per-host readiness probe in
 * app/api/team/members and the workspace-credential watchdog in
 * lib/health/calendar-checks each had their own copy of the same request and
 * the same status-code reasoning. Copies drift, and the drift is silent: tune
 * the 5xx handling in one and the banner and the watchdog quietly disagree
 * about whether OASIS can book, which is the exact failure this codebase
 * already paid for once.
 *
 * ═══ MECHANISM IS SHARED. POLICY IS NOT. ═══════════════════════════════════
 *
 * This returns a three-state verdict and deliberately stops there. `unknown`
 * is a real and distinct answer -- Google had a bad minute, the socket hung up
 * -- and callers legitimately treat it DIFFERENTLY:
 *
 *   the readiness banner  preserves the previous belief, because telling a rep
 *                         to reconnect an account that is fine sends them off
 *                         to re-authorise something that was never broken.
 *
 *   a credential-only     may preserve the previous belief, while a check that
 *   status surface        positively claims booking readiness must fail closed
 *                         until a create/delete round trip is proved.
 *
 * Collapsing those into a boolean here would force one of them to be wrong.
 * What must not differ is the CLASSIFICATION, and that is what lives here.
 */

import "server-only";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * One wall-clock allowance for the mutating readiness proof, including delete.
 *
 * The route that owns this check has a 60 second platform ceiling. Per-request
 * timeouts used to add up to almost that entire ceiling before persistence and
 * the other health checks ran. Keep this at half the route allowance and hold
 * the final request-sized slice exclusively for idempotent cleanup.
 */
export const CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS = 30_000;
export const CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS = DEFAULT_TIMEOUT_MS;

export type TokenProbeVerdict =
  /** Google honoured the grant. */
  | "live"
  /** Google definitively refused it: revoked, wrong client, malformed. */
  | "dead"
  /** Google could not be asked. NOT a synonym for either of the above. */
  | "unknown";

/**
 * The only Google diagnostics permitted to leave this module.
 *
 * Google also returns `error_description`, account hints, and arbitrary nested
 * response bodies. None of that is needed to choose a remedy, and retaining it
 * would turn a health result into a quiet data-exfiltration path. Unknown
 * upstream strings therefore collapse into one fixed code.
 */
export type GoogleProbeErrorCode =
  | "invalid_grant"
  | "invalid_client"
  | "google_token_rejected"
  | "google_token_response_invalid"
  | "calendar_access_rejected"
  | "calendar_write_rejected"
  | "calendar_write_unverified"
  | "calendar_cleanup_failed";

export type GoogleProbeResult = {
  verdict: TokenProbeVerdict;
  errorCode: GoogleProbeErrorCode | null;
};

type BudgetClock = () => number;

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.floor(Number(value)))
    : fallback;
}

function timeoutWithin(deadlineMs: number, requestedMs: number, clock: BudgetClock): number | null {
  const remainingMs = Math.floor(deadlineMs - clock());
  return remainingMs > 0 ? Math.max(1, Math.min(requestedMs, remainingMs)) : null;
}

type TokenExchangeResult = GoogleProbeResult & { accessToken: string | null };

function redactedTokenErrorCode(value: unknown): GoogleProbeErrorCode {
  return value === "invalid_grant" || value === "invalid_client"
    ? value
    : "google_token_rejected";
}

async function exchangeRefreshToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<TokenExchangeResult> {
  if (!args.refreshToken || !args.clientId || !args.clientSecret) {
    return { verdict: "dead", errorCode: "google_token_rejected", accessToken: null };
  }

  const doFetch = args.fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
        client_id: args.clientId,
        client_secret: args.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) {
      // The access token is consumed only inside this module. It never appears
      // in the exported result, logs, alert text, or persisted health rows.
      const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
      const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
      return accessToken
        ? { verdict: "live", errorCode: null, accessToken }
        : { verdict: "unknown", errorCode: "google_token_response_invalid", accessToken: null };
    }
    if (res.status >= 400 && res.status < 500) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return {
        verdict: "dead",
        errorCode: redactedTokenErrorCode(body?.error),
        accessToken: null,
      };
    }
    return { verdict: "unknown", errorCode: null, accessToken: null };
  } catch {
    return { verdict: "unknown", errorCode: null, accessToken: null };
  }
}

/** Spend the refresh grant and return only a redacted, operator-actionable diagnosis. */
export async function probeRefreshTokenDetailed(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<GoogleProbeResult> {
  const { verdict, errorCode } = await exchangeRefreshToken(args);
  return { verdict, errorCode };
}

/**
 * Spend the credential and report what Google said.
 *
 * Presents `clientId`/`clientSecret` as given: a refresh grant is only valid
 * from the client that MINTED it, so the caller must pass the credential's own
 * client rather than whichever one happens to be in the environment. Getting
 * that wrong is #331 and it presents as `invalid_client`, a 4xx -- correctly
 * reported here as `dead`, because from the caller's side a credential that
 * cannot be spent with the client it has IS dead.
 */
export async function probeRefreshToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<TokenProbeVerdict> {
  return (await probeRefreshTokenDetailed(args)).verdict;
}

/**
 * Prove read access to the exact target calendar without creating an event.
 *
 * This is the safe first gate for any live write verifier: refresh the grant,
 * then call events.list with maxResults=1. A 2xx proves both Calendar scope and
 * access to `calendarId`; a 4xx is a stable credential/access failure; a 5xx or
 * transport error remains unknown. Response bodies and access tokens never
 * leave this module.
 */
export async function probeCalendarEventsList(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  calendarId: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<GoogleProbeResult> {
  const exchange = await exchangeRefreshToken(args);
  if (exchange.verdict !== "live" || !exchange.accessToken) {
    return { verdict: exchange.verdict, errorCode: exchange.errorCode };
  }
  if (!args.calendarId.trim()) {
    return { verdict: "dead", errorCode: "calendar_access_rejected" };
  }

  const url = new URL(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(args.calendarId)}/events`,
  );
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("singleEvents", "true");

  const doFetch = args.fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${exchange.accessToken}` },
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) return { verdict: "live", errorCode: null };
    return res.status >= 400 && res.status < 500
      ? { verdict: "dead", errorCode: "calendar_access_rejected" }
      : { verdict: "unknown", errorCode: null };
  } catch {
    return { verdict: "unknown", errorCode: null };
  }
}

/**
 * Prove the target calendar can perform the exact permission bookings need.
 *
 * A successful events.list only proves read scope. This verifier inserts one
 * private, transparent event with a caller-independent id, proves Google
 * provisioned its Meet entry point, then removes it. Cleanup is attempted after every insert response, including
 * failures, because a timed-out insert may still have reached Google. Only a
 * confirmed create followed by a confirmed delete is `live`.
 *
 * Neither Google response bodies nor the short-lived access token cross this
 * module boundary.
 */
export async function probeCalendarWriteRoundTrip(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  calendarId: string;
  /** Internal operator address only; the readiness probe must never invite a prospect. */
  attendeeEmail: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Deterministic injection for tests. Production callers should omit it. */
  eventId?: string;
  /** Deterministic injection for tests. */
  nowMs?: number;
  /** Bounded retries for Google's asynchronous Meet provisioning. */
  meetPollAttempts?: number;
  /** Deterministic injection for tests. */
  meetPollIntervalMs?: number;
  /** Deterministic injection for tests. */
  sleepImpl?: (milliseconds: number) => Promise<void>;
  /** Whole-probe budget. Callers may tighten, but cannot extend, the production ceiling. */
  totalBudgetMs?: number;
  /** Time kept unavailable to create/poll so an ambiguous insert can still be deleted. */
  cleanupReserveMs?: number;
  /** Monotonic clock injection for deterministic budget tests. */
  budgetClockMs?: () => number;
}): Promise<GoogleProbeResult> {
  const clock: BudgetClock = args.budgetClockMs
    || (() => globalThis.performance?.now?.() ?? Date.now());
  const requestedTotalBudgetMs = positiveMilliseconds(
    args.totalBudgetMs,
    CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS,
  );
  // A caller can make a one-off probe stricter, but can never quietly restore
  // the old additive ~58 second path inside the 60 second health route.
  const totalBudgetMs = Math.min(
    requestedTotalBudgetMs,
    CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS,
  );
  const requestedCleanupReserveMs = positiveMilliseconds(
    args.cleanupReserveMs,
    CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS,
  );
  const cleanupReserveMs = Math.min(
    requestedCleanupReserveMs,
    CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS,
    Math.max(1, totalBudgetMs - 1),
  );
  const requestTimeoutMs = positiveMilliseconds(args.timeoutMs, DEFAULT_TIMEOUT_MS);
  const startedAtMs = clock();
  const hardDeadlineMs = startedAtMs + totalBudgetMs;
  const workDeadlineMs = hardDeadlineMs - cleanupReserveMs;

  const exchangeTimeoutMs = timeoutWithin(workDeadlineMs, requestTimeoutMs, clock);
  if (exchangeTimeoutMs === null) {
    return { verdict: "unknown", errorCode: "calendar_write_unverified" };
  }
  const exchange = await exchangeRefreshToken({ ...args, timeoutMs: exchangeTimeoutMs });
  if (exchange.verdict !== "live" || !exchange.accessToken) {
    return { verdict: exchange.verdict, errorCode: exchange.errorCode };
  }

  const calendarId = args.calendarId.trim();
  const attendeeEmail = args.attendeeEmail.trim().toLowerCase();
  if (!calendarId || !attendeeEmail || !attendeeEmail.includes("@")) {
    return { verdict: "dead", errorCode: "calendar_write_rejected" };
  }

  // Google event ids use base32hex characters (a-v and 0-9). UUID hex with a
  // fixed alphabet-safe prefix satisfies that contract and makes collision
  // with a real event practically impossible.
  const eventId = args.eventId?.trim() || `oasishc${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  const nowMs = Number.isFinite(args.nowMs) ? Number(args.nowMs) : Date.now();
  const startsAt = new Date(nowMs + 2 * 60_000);
  const endsAt = new Date(nowMs + 3 * 60_000);
  const eventsUrl = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const createUrl = new URL(eventsUrl);
  createUrl.searchParams.set("conferenceDataVersion", "1");
  createUrl.searchParams.set("sendUpdates", "none");
  const cleanupUrl = new URL(`${eventsUrl}/${encodeURIComponent(eventId)}`);
  cleanupUrl.searchParams.set("sendUpdates", "none");
  const doFetch = args.fetchImpl || globalThis.fetch;
  const authorization = { authorization: `Bearer ${exchange.accessToken}` };

  const hasMeetEntryPoint = (value: unknown): boolean => {
    const body = value as {
      conferenceData?: { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> };
    } | null;
    return (body?.conferenceData?.entryPoints || []).some((entry) => {
      if (entry.entryPointType !== "video" || typeof entry.uri !== "string") return false;
      try {
        const uri = new URL(entry.uri);
        return uri.protocol === "https:" && uri.hostname === "meet.google.com";
      } catch {
        return false;
      }
    });
  };

  let createVerdict: GoogleProbeErrorCode | null = "calendar_write_unverified";
  const createTimeoutMs = timeoutWithin(workDeadlineMs, requestTimeoutMs, clock);
  // Token exchange is non-mutating. If it consumed the entire work window,
  // fail closed without issuing a pointless DELETE for an event never sent.
  if (createTimeoutMs === null) {
    return { verdict: "dead", errorCode: "calendar_write_unverified" };
  }
  try {
    const createRes = await doFetch(createUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        id: eventId,
        summary: "OASIS calendar readiness check",
        description: "Synthetic event created and removed by the OASIS booking readiness monitor.",
        visibility: "private",
        transparency: "transparent",
        reminders: { useDefault: false },
        attendees: [{ email: attendeeEmail }],
        conferenceData: {
          createRequest: {
            requestId: `${eventId}meet`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
        start: { dateTime: startsAt.toISOString(), timeZone: "UTC" },
        end: { dateTime: endsAt.toISOString(), timeZone: "UTC" },
      }),
      signal: AbortSignal.timeout(createTimeoutMs),
    });
    if (!createRes.ok) {
      createVerdict = createRes.status >= 400 && createRes.status < 500
        ? "calendar_write_rejected"
        : "calendar_write_unverified";
    } else {
      const created = await createRes.json().catch(() => null);
      createVerdict = hasMeetEntryPoint(created) ? null : "calendar_write_unverified";

      const pollAttempts = Math.max(0, Math.min(6, args.meetPollAttempts ?? 4));
      const pollIntervalMs = Math.max(0, Math.min(2_000, args.meetPollIntervalMs ?? 500));
      const sleep = args.sleepImpl || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
      const eventUrl = `${eventsUrl}/${encodeURIComponent(eventId)}`;
      for (let attempt = 0; createVerdict && attempt < pollAttempts; attempt += 1) {
        const sleepBudgetMs = timeoutWithin(workDeadlineMs, pollIntervalMs || 1, clock);
        if (sleepBudgetMs === null) break;
        if (pollIntervalMs > 0) await sleep(Math.min(pollIntervalMs, sleepBudgetMs));

        const pollTimeoutMs = timeoutWithin(workDeadlineMs, requestTimeoutMs, clock);
        if (pollTimeoutMs === null) break;
        const readRes = await doFetch(eventUrl, {
          method: "GET",
          headers: authorization,
          signal: AbortSignal.timeout(pollTimeoutMs),
        });
        if (!readRes.ok) continue;
        const event = await readRes.json().catch(() => null);
        if (hasMeetEntryPoint(event) && clock() <= workDeadlineMs) createVerdict = null;
      }
    }
    // A response that arrived after the work window is not allowed to spend
    // the cleanup reserve or certify readiness. The delete below still runs.
    if (clock() > workDeadlineMs) createVerdict = "calendar_write_unverified";
  } catch {
    createVerdict = "calendar_write_unverified";
  }

  let cleanupConfirmed = false;
  const cleanupTimeoutMs = timeoutWithin(hardDeadlineMs, requestTimeoutMs, clock);
  if (cleanupTimeoutMs !== null) {
    try {
      const cleanupRes = await doFetch(cleanupUrl, {
        method: "DELETE",
        headers: authorization,
        signal: AbortSignal.timeout(cleanupTimeoutMs),
      });
      // A 404 proves there is no synthetic event left behind. This is expected
      // when Google definitively rejected the insert. A late mock/transport
      // response cannot make the bounded probe green after its hard deadline.
      cleanupConfirmed = (cleanupRes.ok || cleanupRes.status === 404) && clock() <= hardDeadlineMs;
    } catch {
      cleanupConfirmed = false;
    }
  }

  if (!cleanupConfirmed) {
    return { verdict: "dead", errorCode: "calendar_cleanup_failed" };
  }
  if (createVerdict) {
    return { verdict: "dead", errorCode: createVerdict };
  }
  return { verdict: "live", errorCode: null };
}
