import assert from "node:assert/strict";
import { CALENDAR_CHECKS } from "../lib/health/calendar-checks";

/**
 * tests/calendar-health-check.test.ts — the watchdog on the booking chain.
 *
 * The check exists because a credential Google has revoked is indistinguishable
 * from a healthy one until you spend it. These cases pin the three verdicts
 * that matter and, crucially, that "unknown" is NOT graded as broken.
 */

const check = CALENDAR_CHECKS.find((c) => c.id === "calendar.workspace_credential_usable");
assert.ok(check, "the workspace credential check must be registered");
assert.equal(check.severity, "critical", "nobody being able to book is critical");

const ENV_KEYS = [
  "VERCEL_ENV",
  "GOOGLE_SYSTEM_CALENDAR_CLIENT_ID",
  "GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET",
  "GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN",
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
  process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID = "workspace-client";
  process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET = "workspace-secret";
  process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN = "workspace-refresh";
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
    // Bespoke stub here rather than stubFetch(): this case also captures the
    // request body, to prove the WORKSPACE client is the one presented.
    globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
      sentBody = String(init?.body || "");
      return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 0, "a credential Google accepts is healthy");
    assert.ok(
      sentBody.includes("client_id=workspace-client"),
      "the check must spend the credential with the WORKSPACE client — probing with the " +
        "rep-facing client is the exact bug #331 fixed and would make this watchdog report " +
        "a false outage",
    );

    // ─── 2. A revoked credential is a critical failure ──────────────────────
    configure();
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    assert.equal(await observe(), 2, "a 4xx from Google is definitive: nobody can book (2 = rejected)");
    const revoked = check.describe({ id: check.id, verdict: "failing", observed: 2, baseline: 0, reason: "" });
    assert.match(revoked, /reconnect will NOT fix this/i, "must not send someone to reconnect a host");
    assert.match(revoked, /SAME OAuth client/i, "must name the client-mismatch trap that caused the outage");

    // ─── 3. Missing configuration is a failure, not a pass ──────────────────
    configure();
    delete process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    stubFetch(() => new Response("{}", { status: 200 }));
    assert.equal(await observe(), 1, "no workspace credential at all means no fallback exists (1 = unconfigured)");
    const unconfigured = check.describe({ id: check.id, verdict: "failing", observed: 1, baseline: 0, reason: "" });
    assert.match(unconfigured, /NOT CONFIGURED/i, "the two failures must read differently");

    // ─── 4. UNKNOWN IS NOT BROKEN ───────────────────────────────────────────
    // The single most important case. A monitor that pages on every Google
    // wobble gets muted, and a muted monitor is worse than none.
    configure();
    stubFetch(() => new Response("upstream", { status: 503 }));
    assert.equal(await observe(), 0, "a 5xx is Google's problem, not an OASIS outage");

    configure();
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof globalThis.fetch;
    assert.equal(await observe(), 0, "a transport failure is unknown, not dead");

    // ─── 5. Non-production is never graded ──────────────────────────────────
    configure();
    process.env.VERCEL_ENV = "preview";
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
