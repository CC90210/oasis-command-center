import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { matchesPathPrefix } from "../lib/path-prefix";
import { isPublic, middleware } from "../middleware";

const cases: Array<[string, string, boolean]> = [
  ["/api/cron", "/api/cron", true],
  ["/api/cron/materialize-plans", "/api/cron", true],
  ["/api/cron-jobs", "/api/cron", false],
  ["/api/cron-jobs/poll", "/api/cron", false],
  ["/f/oasis/apply/token", "/f/", true],
  ["/favicon.ico", "/favicon", false],
  ["/favicon", "/favicon", true],
];

for (const [pathname, prefix, expected] of cases) {
  assert.equal(matchesPathPrefix(pathname, prefix), expected, `${prefix} vs ${pathname}`);
}

assert.equal(isPublic("/api/forms/submit"), true, "public form submit bypasses session middleware");
assert.equal(isPublic("/api/forms/upload-url"), true, "public form upload signer bypasses session middleware");
assert.equal(isPublic("/api/forms/view"), true, "public form view tracker bypasses session middleware");
assert.equal(isPublic("/api/forms/address-autocomplete"), true, "public form address autocomplete bypasses session middleware");
assert.equal(isPublic("/api/forms"), false, "operator forms list remains session-gated");
assert.equal(isPublic("/api/forms/abc/mint-link"), false, "operator link minting remains session-gated");
assert.equal(isPublic("/oasis-loop/index.html"), true, "OASIS Loop diagram is public static HTML");
assert.equal(isPublic("/oasis-loop/playbook.html"), true, "OASIS Loop playbook is public static HTML");
assert.equal(isPublic("/oasis-looping/index.html"), false, "OASIS Loop public prefix does not over-match");

// ── Marketing site (2026-07-31) ────────────────────────────────────────
//
// THE INVARIANT THAT MATTERS: "/" must never be public.
//
// PUBLIC_PATH_PREFIXES spreads MARKETING_PATHS, and matchesPathPrefix
// treats any prefix ending in "/" as a plain startsWith — so a single
// stray "/" entry in that array silently makes EVERY route in the
// application public, dashboard included. Nothing throws, nothing 500s,
// and the app looks entirely normal while serving operator surfaces to
// anonymous visitors. This assertion is the tripwire.
assert.equal(isPublic("/"), false, "root is NOT public — it is auth-gated and rewritten to the marketing home for anonymous visitors only");

// Dashboard surfaces stay gated. Spot-check across different first
// segments so a bad prefix entry can't slip through on one shape.
for (const gated of ["/pipeline", "/settings", "/agents", "/operations", "/leads", "/templates"]) {
  assert.equal(isPublic(gated), false, `${gated} remains session-gated`);
}

// Every marketing route is reachable without a session.
for (const open of [
  "/home", // rewrite target for "/"
  "/fleet",
  "/work",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
  "/dmca",
]) {
  assert.equal(isPublic(open), true, `${open} is public marketing`);
}

// /start left the marketing site on 2026-09-29 (F0 containment): it fed the
// developer install funnel, whose repo went private. It is a 404 now, and off
// the public list with /configure and /demo/sun; tests/f0-containment.test.ts
// pins the rest.
for (const retired of ["/start", "/configure", "/demo/sun"]) {
  assert.equal(isPublic(retired), false, `${retired} is retired and must not be public`);
}

// The marketing prefixes must not over-match a future dashboard route
// that merely shares an opening substring. This is the same class of bug
// the /api/cron vs /api/cron-jobs cases above lock down.
for (const notMarketing of ["/fleeting", "/workflows", "/aboutus", "/contacts", "/started", "/homepage"]) {
  assert.equal(isPublic(notMarketing), false, `${notMarketing} must not inherit a marketing prefix`);
}

// Next's generated metadata images. These carry a build hash and no file
// extension, so they slip past both the prefix list and the extension list.
// Gated, the homepage share card 307s to /login and every unfurl — LinkedIn,
// Slack, iMessage — renders a login screen instead of the card. This shipped
// to production on 2026-07-31 and was caught by fetching the image itself
// rather than trusting the og:image meta tag to mean it resolved.
for (const img of [
  "/opengraph-image",
  "/opengraph-image-pwu6ef",
  "/opengraph-image.png",
  "/twitter-image-a1b2c3",
  "/icon",
  "/apple-icon-9z8y7x",
]) {
  assert.equal(isPublic(img), true, `${img} must be fetchable by an unfurler with no session`);
}

// ...without opening up anything that merely starts the same way.
for (const notAnImage of ["/icons", "/iconography", "/opengraph-image/secret", "/iconic-leads"]) {
  assert.equal(isPublic(notAnImage), false, `${notAnImage} must not be treated as a metadata image`);
}

// The machine-to-machine /api/internal surface. None of these callers can hold
// a session cookie: each is a VPS daemon that authenticates with an HMAC over
// the raw body INSIDE its route. Left off the allowlist, middleware answers 401
// before the signature check ever runs, and the failure looks like a broken
// integration rather than a routing rule.
//
// This has now happened twice. apply-extraction was fixed once, and on
// 2026-08-26 extraction-doc-url shipped in #321 with the same omission — a
// Codex review caught it, otherwise the outage it was written to repair would
// have survived its own fix. Pinning all three so the next one is a red test
// rather than a second silent outage.
for (const internal of [
  "/api/internal/apply-extraction",
  "/api/internal/live-subs/promote",
  "/api/internal/extraction-doc-url",
]) {
  assert.equal(
    isPublic(internal),
    true,
    `${internal} is HMAC-gated inside its route and MUST bypass session middleware, or the daemon 401s before signing is checked`,
  );
}

/**
 * THE PUBLIC FORM'S OWN BEACONS MUST REACH THEIR ROUTES.
 *
 * /api/perf/vitals is sent by the MERCHANT'S browser from the public
 * application form, where no session cookie exists. Left off the allowlist,
 * middleware answered 401 and every merchant filling in a funding application
 * collected console errors on the page — measured live on production
 * 2026-09-14, alongside a consent beacon that was failing for its own reason.
 *
 * The route is a public surface by design and gates itself fail-closed before
 * reading anything (same-origin check, 1 KB cap, strict schema, rate cap,
 * log-only). Same rule as the internal HMAC routes above: the route owns its
 * auth, so middleware has to let it get there.
 */
assert.equal(
  isPublic("/api/perf/vitals"),
  true,
  "/api/perf/vitals is sent from the session-less public form and self-gates on same-origin; 401ing it here breaks the merchant's page",
);
// The crash-report beacon follows the same rule: a signed-out page (login, a
// public form) must be able to report, and only the exact path is public.
assert.equal(isPublic("/api/client-errors"), true, "/api/client-errors is sent from session-less pages and self-gates on same-origin");
for (const notPublic of ["/api/client-errors-admin", "/api/client"]) {
  assert.equal(isPublic(notPublic), false, `${notPublic} must stay session-gated`);
}
// The allowlist entry must NOT become a blanket /api/perf prefix.
for (const notPublic of ["/api/perf", "/api/perf/anything-else", "/api/perf/vitals-admin"]) {
  assert.equal(
    isPublic(notPublic),
    false,
    `${notPublic} must stay session-gated — only the vitals beacon is public`,
  );
}

// The Business Ledger ingest authenticates each producer by HMAC inside its
// route (lib/ledger/ingest.ts); the harnesses hold no session. Only that exact
// path is public: the rest of /api/ledger stays behind the session.
assert.equal(isPublic("/api/ledger/ingest"), true, "/api/ledger/ingest is HMAC-gated inside its route and must reach it");
for (const notPublic of ["/api/ledger", "/api/ledger/events", "/api/ledger/ingest-admin"]) {
  assert.equal(isPublic(notPublic), false, `${notPublic} must stay session-gated — only the ingest path is public`);
}

// Skills Training machine check-in (JARVIS plan 2, Task 7). The PC holds a
// per-computer key, not a session cookie, and authenticates INSIDE
// lib/skills/machine-auth.ts; left off the allowlist every real check-in
// would 401 here before that key check ever runs. Only the check-in
// sub-path is public — the admin surfaces Adon's session uses
// (computers, overview, and the change-authoring POST /api/skills/changes)
// must stay session-gated.
for (const checkin of [
  "/api/skills/checkin/poll",
  "/api/skills/checkin/skills",
  "/api/skills/checkin/changes",
  "/api/skills/checkin/report",
]) {
  assert.equal(isPublic(checkin), true, `${checkin} is key-gated inside its route and MUST bypass session middleware`);
}
for (const notPublic of ["/api/skills/changes", "/api/skills/overview", "/api/skills/computers", "/api/skills/checkin", "/api/skills/checkin-admin"]) {
  assert.equal(isPublic(notPublic), false, `${notPublic} must stay session-gated — only /api/skills/checkin/* is public`);
}

// The support@ reader (BEA, on CC's PC) posts to four routes under
// /api/internal/support/, each HMAC-gated inside (lib/delivery/support-ingest-auth.ts).
// A 401 from middleware would read to the reader as a bad signature and stop
// the desk, so the prefix is public, and only that prefix.
for (const support of [
  "/api/internal/support/ingest",
  "/api/internal/support/heartbeat",
  "/api/internal/support/pending-drafts",
  "/api/internal/support/draft",
]) {
  assert.equal(isPublic(support), true, `${support} is HMAC-gated inside its route and MUST bypass session middleware`);
}
for (const notPublic of ["/api/internal/supportx", "/api/internal/support-admin", "/api/internal/supported/ingest"]) {
  assert.equal(isPublic(notPublic), false, `${notPublic} must stay session-gated — only /api/internal/support/* is public`);
}

// ...and nothing else under /api/internal is public. The prefix must not be a
// wildcard: a future internal route stays session-gated until someone
// deliberately adds it above with a reason.
for (const notPublic of [
  "/api/internal",
  "/api/internal/anything-else",
  "/api/internal/apply-extraction-secrets",
  "/api/internal/extraction-doc-url-admin",
  "/api/internal/live-subs",
]) {
  assert.equal(
    isPublic(notPublic),
    false,
    `${notPublic} must stay session-gated — /api/internal is not a blanket public prefix`,
  );
}

// /api/quests served CC's ACTIVE_TASKS mirror (55 rows of oasis_quests) to the
// whole internet "for Phase 5 proof-of-life" (doc 02 F2 / P0-6, 2026-09-28).
// It is operator-only now; middleware must 401 a signed-out caller before the
// route runs, and the route itself refuses any non-operator
// (tests/admin-surfaces-operator-only.test.ts).
for (const gated of ["/api/quests", "/api/quests/anything"]) {
  assert.equal(isPublic(gated), false, `${gated} must stay session-gated — it is CC's task list`);
}

/**
 * /link-expired, through the REAL middleware, with no session (W1a, U1-18).
 *
 * /api/track/click sends a click it cannot attribute to /link-expired, a page
 * that belongs to no company. The visitor is someone's email recipient, usually
 * with no account, and was being sent to /login?next=/link-expired: "Sign in to
 * Command Center" for a product they do not use. The session gate is armed here
 * (Turso auth with a secret) and proven armed by /pipeline, so a pass-through
 * for /link-expired means the public list let it through, not that no gate ran.
 *
 * The same run pins that middleware does NOT move the AI team's old builder and
 * teammate-chat URLs (lib/os/redirects.ts OS_VIEWER_MOVES): it cannot tell
 * whether the OS page serves the viewer, and a 308 to /agents/new sent every
 * client owner's Build click to a 404, cached by the browser as permanent
 * (W1a review R1). Signed out they meet the session gate like any page; the
 * page itself moves the viewers the OS route serves.
 */
async function anonymously(path: string): Promise<Response> {
  process.env.EMPIRE_AUTH_BACKEND = "turso";
  process.env.AUTH_SESSION_SECRET = "middleware-prefix-test-secret-long-enough-0001";
  return middleware(new NextRequest(`https://oasisai.work${path}`));
}

async function throughMiddleware(): Promise<void> {
  const gated = await anonymously("/pipeline");
  assert.equal(gated.status, 307, "precondition: the session gate is armed for an anonymous page request");
  assert.equal(new URL(gated.headers.get("location") || "").pathname, "/login");

  assert.equal(isPublic("/link-expired"), true, "/link-expired is on the public list");
  for (const notPublic of ["/link-expired-admin", "/link"]) {
    assert.equal(isPublic(notPublic), false, `${notPublic} must not inherit /link-expired`);
  }
  const res = await anonymously("/link-expired");
  assert.equal(res.status, 200, "an anonymous visitor reaches /link-expired");
  assert.equal(res.headers.get("location"), null, "no redirect, so no 'Sign in to Command Center'");
  assert.equal(res.headers.get("x-middleware-next"), "1", "middleware passes the request through to the page");

  for (const old of [
    "/t/acme-roofing/marketplace/new",
    "/t/acme-roofing/marketplace/new?template=setter",
    "/t/acme-roofing/marketplace/new?edit=outreach-sniper",
    "/t/acme-roofing/agent/outreach-sniper",
    "/t/acme-roofing/agent/%73dr",
    "/t/acme-roofing/marketplace",
  ]) {
    const res2 = await anonymously(old);
    assert.notEqual(res2.status, 308, `${old}: middleware made a permanent move`);
    assert.equal(res2.status, 307, `${old} meets the session gate like any page`);
    const location = new URL(res2.headers.get("location") || "");
    assert.equal(location.pathname, "/login", `${old} was moved somewhere other than sign-in`);
    assert.equal(location.searchParams.get("next"), new URL(old, "https://oasisai.work").pathname, `${old}: sign-in returns to the page`);
  }
}

throughMiddleware().then(
  () => console.log("middleware-prefix ok"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
