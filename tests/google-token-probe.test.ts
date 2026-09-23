import assert from "node:assert/strict";
import {
  CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS,
  CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS,
  probeCalendarEventsList,
  probeCalendarWriteRoundTrip,
  probeRefreshToken,
  probeRefreshTokenDetailed,
} from "../lib/integrations/google-token-probe";

/**
 * tests/google-token-probe.test.ts
 *
 * This module is the single answer to "is this Google credential spendable",
 * shared by the handoff readiness banner and the workspace-calendar watchdog.
 * The 2026-08-26 outage was two surfaces asking that question differently and
 * getting different answers, so the three-state contract is the thing under
 * test here — especially that `unknown` is distinct from both.
 */

const CREDS = {
  refreshToken: "refresh-value",
  clientId: "client-value",
  clientSecret: "secret-value",
};

const ok = () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 });

async function run() {
  // Diagnostics distinguish the two operator remedies without retaining any
  // Google response text. error_description can contain account data (and, in
  // a malicious upstream response, our own credential values), so only a tiny
  // allowlist of error codes may cross the probe boundary.
  for (const code of ["invalid_grant", "invalid_client"] as const) {
    const leak = `do-not-retain ${CREDS.refreshToken} ${CREDS.clientSecret}`;
    const result = await probeRefreshTokenDetailed({
      ...CREDS,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: code, error_description: leak }), { status: 400 })) as typeof fetch,
    });
    assert.deepEqual(result, { verdict: "dead", errorCode: code });
    assert.equal(JSON.stringify(result).includes(leak), false, "Google error descriptions must be discarded");
    assert.equal(JSON.stringify(result).includes(CREDS.refreshToken), false, "refresh tokens must not escape diagnostics");
  }
  assert.deepEqual(
    await probeRefreshTokenDetailed({
      ...CREDS,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "attacker_supplied_secret_name", error_description: "private" }), {
          status: 400,
        })) as typeof fetch,
    }),
    { verdict: "dead", errorCode: "google_token_rejected" },
    "unrecognised upstream strings collapse to a fixed redacted code",
  );

  // ─── live ────────────────────────────────────────────────────────────────
  assert.equal(
    await probeRefreshToken({ ...CREDS, fetchImpl: (async () => ok()) as typeof fetch }),
    "live",
  );

  // ─── dead: every 4xx, not just the one we happened to see ────────────────
  for (const [status, label] of [
    [400, "invalid_grant — revoked or withdrawn"],
    [401, "invalid_client — minted by a different OAuth client (#331)"],
    [403, "forbidden"],
  ] as const) {
    assert.equal(
      await probeRefreshToken({
        ...CREDS,
        fetchImpl: (async () => new Response("{}", { status })) as typeof fetch,
      }),
      "dead",
      `${status} must be dead: ${label}`,
    );
  }

  // ─── unknown: Google could not be ASKED ──────────────────────────────────
  // The case that must never be collapsed into live or dead. Both callers
  // depend on being able to tell "no" apart from "no answer", and they act on
  // it differently on purpose.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(
      await probeRefreshToken({
        ...CREDS,
        fetchImpl: (async () => new Response("upstream", { status })) as typeof fetch,
      }),
      "unknown",
      `${status} is Google's problem and says nothing about the credential`,
    );
  }
  assert.equal(
    await probeRefreshToken({
      ...CREDS,
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    }),
    "unknown",
    "a transport failure is not a rejection",
  );

  // ─── missing inputs are dead, and cost no network call ───────────────────
  for (const missing of [
    { refreshToken: "" },
    { clientId: "" },
    { clientSecret: "" },
  ]) {
    let called = false;
    const verdict = await probeRefreshToken({
      ...CREDS,
      ...missing,
      fetchImpl: (async () => {
        called = true;
        return ok();
      }) as typeof fetch,
    });
    assert.equal(verdict, "dead", `${Object.keys(missing)[0]} empty must be dead`);
    assert.equal(called, false, "an incomplete credential must not hit Google");
  }

  // ─── the credential is presented with the client it was given ────────────
  // Not the ambient one. Spending a workspace credential with the rep-facing
  // client is #331, and it returns invalid_client — a failure that looks like
  // revocation and sends people to the wrong remedy.
  let body = "";
  await probeRefreshToken({
    refreshToken: "workspace-refresh",
    clientId: "workspace-client",
    clientSecret: "workspace-secret",
    fetchImpl: (async (_u: unknown, init: RequestInit) => {
      body = String(init?.body || "");
      return ok();
    }) as typeof fetch,
  });
  assert.ok(body.includes("refresh_token=workspace-refresh"), "must send the given credential");
  assert.ok(body.includes("client_id=workspace-client"), "must send the given client");
  assert.ok(body.includes("client_secret=workspace-secret"), "must send the given secret");
  assert.ok(body.includes("grant_type=refresh_token"), "must be a refresh grant");

  // Before the live verifier writes an event, it must prove read access to the
  // exact target calendar with an events.list request. This is deliberately a
  // GET and never exposes the short-lived access token in its return value.
  const calls: Array<{ url: string; method: string; authorization: string }> = [];
  const calendarResult = await probeCalendarEventsList({
    ...CREDS,
    calendarId: "shared calendar@group.calendar.google.com",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization || ""),
      });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "short-lived-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(calendarResult, { verdict: "live", errorCode: null });
  assert.equal(calls.length, 2, "calendar access is proved only after the refresh grant succeeds");
  assert.equal(calls[1].method, "GET", "the preflight must be non-mutating");
  assert.match(calls[1].url, /calendar\/v3\/calendars\/shared%20calendar%40group\.calendar\.google\.com\/events/);
  assert.equal(calls[1].authorization, "Bearer short-lived-token");
  assert.equal(JSON.stringify(calendarResult).includes("short-lived-token"), false);

  const rejectedCalendar = await probeCalendarEventsList({
    ...CREDS,
    calendarId: "target",
    fetchImpl: (async (url: string | URL | Request) =>
      String(url).includes("oauth2.googleapis.com/token")
        ? new Response(JSON.stringify({ access_token: "a" }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "private account detail" } }), { status: 403 })) as typeof fetch,
  });
  assert.deepEqual(rejectedCalendar, { verdict: "dead", errorCode: "calendar_access_rejected" });
  assert.equal(JSON.stringify(rejectedCalendar).includes("private account detail"), false);

  // Continuous readiness must prove the permission bookings actually need,
  // then remove its private/transparent synthetic event. A read-only token can
  // pass events.list, so GET alone is not booking readiness.
  const writeCalls: Array<{ url: string; method: string; body: string }> = [];
  const writeResult = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishc0123456789abcdef",
    nowMs: Date.parse("2026-09-23T07:00:00Z"),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      writeCalls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: String(init?.body || ""),
      });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "short-lived-token" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "oasishc0123456789abcdef",
          conferenceData: {
            entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
          },
        }), { status: 200 });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("unexpected request");
    }) as typeof fetch,
  });
  assert.deepEqual(writeResult, { verdict: "live", errorCode: null });
  assert.deepEqual(writeCalls.map((call) => call.method), ["POST", "POST", "DELETE"]);
  assert.match(writeCalls[1].url, /[?&]conferenceDataVersion=1(?:&|$)/);
  assert.match(writeCalls[1].url, /[?&]sendUpdates=none(?:&|$)/);
  assert.match(writeCalls[1].body, /"transparency":"transparent"/);
  assert.match(writeCalls[1].body, /"visibility":"private"/);
  assert.match(writeCalls[1].body, /"attendees":\[\{"email":"operator@oasisai\.work"\}\]/);
  assert.match(writeCalls[1].body, /"conferenceData":\{"createRequest":\{"requestId":"oasishc0123456789abcdefmeet"/);
  assert.equal(JSON.stringify(writeResult).includes("short-lived-token"), false);

  // A plain event insert is not proof that founder bookings work. Google can
  // accept the event while rejecting/omitting conference provisioning, which
  // is the exact path the booking flow relies on.
  let missingMeetCleanupAttempted = false;
  const missingMeet = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishc1111111111111111",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "oasishc1111111111111111" }), { status: 200 });
      }
      missingMeetCleanupAttempted = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.equal(missingMeetCleanupAttempted, true, "a no-Meet insert must still be removed");
  assert.notEqual(missingMeet.verdict, "live", "plain insert success cannot certify Meet booking readiness");

  let rejectedMeetCleanupAttempted = false;
  const rejectedMeet = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishc2222222222222222",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: { message: "conference creation rejected" } }), { status: 400 });
      }
      rejectedMeetCleanupAttempted = true;
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  assert.equal(rejectedMeetCleanupAttempted, true, "a rejected Meet insert must get idempotent cleanup");
  assert.deepEqual(rejectedMeet, { verdict: "dead", errorCode: "calendar_write_rejected" });

  let cleanupAttempted = false;
  const cleanupFailure = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishcabcdef0123456789",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "oasishcabcdef0123456789",
          conferenceData: {
            entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
          },
        }), { status: 200 });
      }
      cleanupAttempted = true;
      return new Response(JSON.stringify({ error: { message: "private cleanup detail" } }), { status: 500 });
    }) as typeof fetch,
  });
  assert.equal(cleanupAttempted, true, "a successful create must always be followed by cleanup");
  assert.deepEqual(cleanupFailure, { verdict: "dead", errorCode: "calendar_cleanup_failed" });
  assert.equal(JSON.stringify(cleanupFailure).includes("private cleanup detail"), false);

  let rejectedCleanupAttempted = false;
  const rejectedWrite = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishcdeadbeef01234567",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: { message: "private write detail" } }), { status: 403 });
      }
      rejectedCleanupAttempted = true;
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  assert.equal(rejectedCleanupAttempted, true, "even an ambiguous/refused write gets an idempotent cleanup attempt");
  assert.deepEqual(rejectedWrite, { verdict: "dead", errorCode: "calendar_write_rejected" });
  assert.equal(JSON.stringify(rejectedWrite).includes("private write detail"), false);

  // The write proof owns one deadline, rather than multiplying an 8 second
  // timeout by token + create + four polls + cleanup. Advance a fake monotonic
  // clock to the work boundary: polls must stop there and DELETE must still
  // receive the reserved final slice.
  assert.equal(CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS, 30_000);
  assert.equal(CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS, 8_000);
  let budgetClock = 0;
  const budgetCalls: Array<{ method: string; atMs: number }> = [];
  const boundedResult = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishcbudget0000000000",
    timeoutMs: 1_000,
    totalBudgetMs: 100,
    cleanupReserveMs: 30,
    meetPollIntervalMs: 20,
    budgetClockMs: () => budgetClock,
    sleepImpl: async (milliseconds) => { budgetClock += milliseconds; },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(init?.method || "GET");
      budgetCalls.push({ method, atMs: budgetClock });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        budgetClock += 20;
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (method === "POST") {
        budgetClock += 45;
        return new Response(JSON.stringify({ id: "oasishcbudget0000000000" }), { status: 200 });
      }
      if (method === "DELETE") {
        budgetClock += 25;
        return new Response(null, { status: 204 });
      }
      throw new Error(`the Meet poll crossed into the cleanup reserve at ${budgetClock}ms`);
    }) as typeof fetch,
  });
  assert.deepEqual(budgetCalls, [
    { method: "POST", atMs: 0 },
    { method: "POST", atMs: 20 },
    { method: "DELETE", atMs: 70 },
  ]);
  assert.equal(budgetClock, 95, "the cleanup completes within the 100ms synthetic total budget");
  assert.deepEqual(
    boundedResult,
    { verdict: "dead", errorCode: "calendar_write_unverified" },
    "budget exhaustion fails closed even when deletion succeeds",
  );

  // A transport test double that ignores AbortSignal still cannot certify a
  // cleanup response delivered after the hard deadline.
  let lateClock = 0;
  const lateCleanup = await probeCalendarWriteRoundTrip({
    ...CREDS,
    calendarId: "target",
    attendeeEmail: "operator@oasisai.work",
    eventId: "oasishclate000000000000",
    timeoutMs: 1_000,
    totalBudgetMs: 100,
    cleanupReserveMs: 30,
    meetPollAttempts: 0,
    budgetClockMs: () => lateClock,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        lateClock += 20;
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") {
        lateClock += 45;
        return new Response(JSON.stringify({ id: "oasishclate000000000000" }), { status: 200 });
      }
      lateClock += 36;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.equal(lateClock, 101);
  assert.deepEqual(lateCleanup, { verdict: "dead", errorCode: "calendar_cleanup_failed" });

  console.log("google-token-probe: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
