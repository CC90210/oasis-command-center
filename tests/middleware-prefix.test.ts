import assert from "node:assert/strict";
import { matchesPathPrefix } from "../lib/path-prefix";
import { isPublic } from "../middleware";

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
  "/start",
  "/privacy",
  "/terms",
  "/dmca",
]) {
  assert.equal(isPublic(open), true, `${open} is public marketing`);
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

console.log("middleware-prefix ok");
