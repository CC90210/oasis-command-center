import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALENDAR_CHECKS, createCalendarChecks } from "../lib/health/calendar-checks";
import {
  CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS,
  CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS,
  probeCalendarWriteRoundTrip,
} from "../lib/integrations/google-token-probe";

/**
 * tests/calendar-health-check.test.ts — the watchdog on the booking chain.
 *
 * The check exists because a credential Google has revoked is indistinguishable
 * from a healthy one until you spend it. These cases pin the three verdicts
 * that matter. Booking readiness fails closed: if create/delete cannot be
 * proved, the monitor must not tell operators that bookings work.
 */

const check = CALENDAR_CHECKS.find((c) => c.id === "calendar.workspace_credential_usable");
assert.ok(check, "the workspace credential check must be registered");
assert.equal(check.severity, "critical", "nobody being able to book is critical");

const ENV_KEYS = [
  "VERCEL_ENV",
  "DEPLOY_ENV",
  "GOOGLE_SYSTEM_CALENDAR_CLIENT_ID",
  "GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET",
  "GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN",
  "GOOGLE_SYSTEM_CALENDAR_ADDRESS",
  "GOOGLE_CALENDAR_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

function restore() {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function configure() {
  process.env.VERCEL_ENV = "production";
  delete process.env.DEPLOY_ENV;
  process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID = "workspace-client";
  process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET = "workspace-secret";
  process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN = "workspace-refresh";
  process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS = "operator@oasisai.work";
  process.env.GOOGLE_CALENDAR_ID = "shared-calendar";
}

const realFetch = globalThis.fetch;
function stubFetch(reply: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => reply()) as typeof globalThis.fetch;
}

// Every observe() below is a no-arg call in practice; the signature carries the
// db/tenant/now params the drip checks need and this one ignores.
const observe = () => check.observe(null as never, "tenant", Date.now());

async function run() {
  try {
    // ─── 1. A live credential is healthy ────────────────────────────────────
    configure();
    let sentBody = "";
    const requestedCalls: Array<{ url: string; method: string; body: string }> = [];
    // Bespoke stub here rather than stubFetch(): this case also captures the
    // request body, to prove the WORKSPACE client is the one presented.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedCalls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: String(init?.body || ""),
      });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        sentBody = String(init?.body || "");
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
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
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 0, "a credential Google accepts is healthy");
    assert.ok(
      sentBody.includes("client_id=workspace-client"),
      "the check must spend the credential with the WORKSPACE client — probing with the " +
        "rep-facing client is the exact bug #331 fixed and would make this watchdog report " +
        "a false outage",
    );
    assert.deepEqual(
      requestedCalls.map((call) => call.method),
      ["POST", "POST", "DELETE"],
      "health must exchange the token, create a private probe, then remove it",
    );
    assert.match(requestedCalls[1].url, /googleapis\.com\/calendar\/v3\/calendars\//);
    assert.match(requestedCalls[1].url, /[?&]conferenceDataVersion=1(?:&|$)/);
    assert.match(requestedCalls[1].url, /[?&]sendUpdates=none(?:&|$)/);
    assert.match(requestedCalls[1].body, /"attendees":\[\{"email":"operator@oasisai\.work"\}\]/);
    assert.match(requestedCalls[1].body, /"conferenceData":\{"createRequest":/);

    configure();
    let missingMeetCleanupAttempted = false;
    let missingMeetSleepCalls = 0;
    const noPollingCheck = createCalendarChecks((args) => probeCalendarWriteRoundTrip({
      ...args,
      meetPollAttempts: 0,
      sleepImpl: async () => { missingMeetSleepCalls += 1; },
    }))[0];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "oasishc0123456789abcdef" }), { status: 200 });
      }
      if (init?.method === "DELETE") {
        missingMeetCleanupAttempted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${String(init?.method || "GET")} request`);
    }) as typeof globalThis.fetch;
    assert.notEqual(
      await noPollingCheck.observe(null as never, "tenant", Date.now()),
      0,
      "an insert without a returned Meet entry point must not be green",
    );
    assert.equal(missingMeetCleanupAttempted, true, "a no-Meet probe event must still be cleaned up");
    assert.equal(missingMeetSleepCalls, 0, "the no-Meet cleanup unit test must not wait on real poll timers");

    // ─── 2. A revoked credential is a critical failure ──────────────────────
    configure();
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    assert.equal(await observe(), 2, "a 4xx from Google is definitive: nobody can book (2 = rejected)");
    const revoked = check.describe({ id: check.id, verdict: "failing", observed: 2, baseline: 0, reason: "" });
    assert.match(revoked, /reconnect will NOT fix this/i, "must not send someone to reconnect a host");
    assert.match(revoked, /invalid_grant/i, "the alert must retain only Google's safe rejection code");

    configure();
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_client", error_description: "private" }), { status: 401 }));
    assert.equal(await observe(), 3, "invalid_client has a distinct remedy from a revoked grant");
    const wrongClient = check.describe({ id: check.id, verdict: "failing", observed: 3, baseline: 0, reason: "" });
    assert.match(wrongClient, /invalid_client/i);
    assert.match(wrongClient, /OAuth client/i);
    assert.equal(wrongClient.includes("private"), false, "Google response descriptions never reach alerts");

    // ─── 3. Missing configuration is a failure, not a pass ──────────────────
    configure();
    delete process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    stubFetch(() => new Response("{}", { status: 200 }));
    assert.equal(await observe(), 1, "no workspace credential at all means no fallback exists (1 = unconfigured)");
    const unconfigured = check.describe({ id: check.id, verdict: "failing", observed: 1, baseline: 0, reason: "" });
    assert.match(unconfigured, /NOT CONFIGURED/i, "the two failures must read differently");
    assert.match(unconfigured, /GOOGLE_CALENDAR_ID/, "the setup remedy must name the target calendar setting");

    configure();
    process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS = "   ";
    globalThis.fetch = (async () => {
      throw new Error("an incomplete organizer identity must fail before calling Google");
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 1, "a blank organizer identity is unconfigured, not a rejected write");

    configure();
    process.env.GOOGLE_CALENDAR_ID = "   ";
    globalThis.fetch = (async () => {
      throw new Error("an implicit primary calendar must not replace the configured shared target");
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 1, "a blank shared-calendar ID is unconfigured, not an implicit primary");

    configure();
    let rejectedWriteCleanupAttempts = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      }
      if (init?.method === "POST") return new Response("{}", { status: 403 });
      if (init?.method === "DELETE") {
        rejectedWriteCleanupAttempts += 1;
        return new Response("{}", { status: 403 });
      }
      throw new Error(`unexpected ${String(init?.method || "GET")} request`);
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 4, "a definitive write rejection must retain its actionable diagnosis");
    assert.equal(rejectedWriteCleanupAttempts, 1, "a rejected write must still attempt cleanup exactly once");
    const rejectedWriteDescription = check.describe({
      id: check.id,
      verdict: "failing",
      observed: 4,
      baseline: 0,
      reason: "",
    });
    assert.match(rejectedWriteDescription, /GOOGLE_CALENDAR_ID/, "the write remedy must name the configured calendar ID");
    assert.doesNotMatch(rejectedWriteDescription, /GOOGLE_SYSTEM_CALENDAR_ID/, "the write remedy must not name a nonexistent setting");

    // ─── 4. UNKNOWN IS NOT BROKEN ───────────────────────────────────────────
    // The check claims founder audits can be booked. If Google never answers,
    // that claim was not proved and must fail closed rather than render green.
    configure();
    stubFetch(() => new Response("upstream", { status: 503 }));
    assert.notEqual(await observe(), 0, "a 5xx cannot certify booking readiness");

    configure();
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof globalThis.fetch;
    assert.notEqual(await observe(), 0, "a transport failure cannot certify booking readiness");

    // Cloudflare production is held to the same check. The old VERCEL_ENV-only
    // gate silently turned this monitor off after a platform cutover.
    configure();
    delete process.env.VERCEL_ENV;
    process.env.DEPLOY_ENV = "production";
    delete process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.equal(await observe(), 1, "Cloudflare production must not bypass calendar health");

    // ─── 5. Non-production is never graded ──────────────────────────────────
    configure();
    process.env.VERCEL_ENV = "preview";
    delete process.env.DEPLOY_ENV;
    globalThis.fetch = (async () => {
      throw new Error("no network call should happen off production");
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 0, "previews legitimately run without a workspace credential");

    console.log("calendar-health-check: OK");
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * DESCRIBE IS A PURE FUNCTION OF ITS RESULT.
 *
 * The first version cached the failure mode in a module-level variable that
 * observe() wrote and describe() read. runCheck awaits between the two, so a
 * second invocation in the same warm process could rewrite the mode under the
 * first and print the wrong remedy — and the two remedies here are opposite
 * (set env vars vs mint a new credential). Calling describe() with each mode,
 * in an order that does not match any observe() that ran, pins that out.
 */
{
  const c = CALENDAR_CHECKS[0];
  const say = (observed: number) =>
    c.describe({ id: c.id, verdict: observed === 0 ? "ok" : "failing", observed, baseline: 0, reason: "" });

  // Deliberately out of order, with no observe() in between.
  assert.match(say(2), /REJECTED BY GOOGLE/i, "2 must always read as rejected");
  assert.match(say(3), /invalid_client/i, "3 must retain the redacted client-mismatch code");
  assert.match(say(1), /NOT CONFIGURED/i, "1 must always read as unconfigured");
  assert.match(say(2), /REJECTED BY GOOGLE/i, "and again, after describing a different mode");
  assert.match(say(0), /is live/i, "0 must always read as healthy");
  assert.ok(
    !say(1).includes("REJECTED BY GOOGLE") && !say(2).includes("NOT CONFIGURED"),
    "the two remedies must never bleed into each other",
  );

  console.log("calendar-health-check: describe is stateless ok");
}

/**
 * THE OASIS-GLOBAL CHECK MUST NOT BE STORED OR RENDERED AS SUNBIZ HEALTH.
 */
{
  const route = readFileSync("app/api/cron/health-check/route.ts", "utf8");
  const page = readFileSync("app/health/page.tsx", "utf8");
  const runner = readFileSync("lib/health/runner.ts", "utf8");
  const panelData = readFileSync("lib/health/outcome-panel-data.ts", "utf8");
  const verifier = readFileSync("scripts/verify-workspace-calendar-live.ts", "utf8");

  assert.match(route, /WEBDEV_TENANT_ID/, "the global OASIS check must be persisted against the OASIS tenant");
  assert.match(route, /checks:\s*CALENDAR_CHECKS/, "the OASIS run must contain only the global calendar checks");
  assert.match(route, /checks:\s*tenantOutcomeChecks\(\)/, "SunBiz's run must exclude the OASIS-global calendar check");
  assert.match(route, /Promise\.all\(\[/, "the Calendar proof must start alongside independent route checks");
  assert.ok(
    route.indexOf("runHealthChecks(WEBDEV_TENANT_ID")
      < route.indexOf("runHealthChecks(SUNBIZ_TENANT_ID"),
    "Calendar must be launched first inside the concurrent batch so cleanup cannot queue behind tenant work",
  );
  const routeSeconds = Number(route.match(/export const maxDuration = (\d+);/)?.[1]);
  assert.equal(routeSeconds, 60, "the budget test must track the deployed route ceiling");
  assert.ok(
    CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS <= (routeSeconds * 1_000) / 2,
    "the complete Calendar mutation+cleanup budget must use at most half the route ceiling",
  );
  assert.ok(
    CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS > 0
      && CALENDAR_WRITE_PROBE_CLEANUP_RESERVE_MS < CALENDAR_WRITE_PROBE_TOTAL_BUDGET_MS,
    "the probe budget must retain a real cleanup-only slice",
  );
  assert.match(runner, /checks\?:\s*readonly DripCheck\[\]/, "the runner must accept an explicit bounded check set");
  assert.match(page, /tenantId === WEBDEV_TENANT_ID/, "the OASIS health page must load its own global outcomes");
  assert.match(page, /includeCheckIds:\s*calendarCheckIds/, "OASIS must render only its calendar check");
  assert.match(page, /excludeCheckIds:\s*calendarCheckIds/, "SunBiz must not retain a stale calendar row");
  assert.match(panelData, /allowsCheck\(id, filter\)/, "persisted run rows must respect the tenant-visible check set");
  assert.match(panelData, /allowsCheck\(checkId, filter\)/, "open alerts must respect the same check set");
  assert.match(page, /OASIS founder-booking health/, "the calendar check needs an operator-visible card, not SunBiz copy");

  const readAt = verifier.indexOf("probeCalendarEventsList");
  const writeAt = verifier.indexOf("createGoogleFounderMeeting(");
  assert.ok(readAt >= 0 && writeAt > readAt, "a non-mutating target-calendar read must happen before event creation");
}

/**
 * THE ALERT MUST REACH THE PEOPLE WHO CAN ACT ON IT.
 *
 * Every check in this runner predates OASIS and defaults to the SunBiz ops
 * lane, which is Adon's channel for a product he operates. A dead OASIS
 * workspace credential is not actionable there — nobody in that room can mint
 * one — and an alert in the wrong room is one nobody acts on, which is
 * indistinguishable from no alert at all.
 */
{
  const c = CALENDAR_CHECKS[0];
  assert.equal(
    c.lane,
    "operator",
    "an OASIS booking outage must page CC's lane, not the SunBiz ops channel",
  );
}
