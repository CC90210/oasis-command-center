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

console.log("middleware-prefix ok");
