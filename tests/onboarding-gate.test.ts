import assert from "node:assert/strict";
import { shouldRedirectToOnboarding } from "../lib/onboarding-gate";

// Regression locks for the 2026-05-29 SunBiz incident. The middleware's
// onboarding gate used to redirect ANYONE with onboarding_completed_at
// null to a wizard — including invitees who had successfully joined a
// tenant via redeem_tenant_invite. That silently overrode the entire
// invite landing flow (signup → /t/<slug>, login → /t/<slug>) for
// every SunBiz member. The fix added the tenant_id check; this test
// makes sure future refactors don't drop it.

// Null profile — page-level provisioning handles it, gate stays out.
assert.equal(shouldRedirectToOnboarding(null), null, "null profile: no redirect");

// Onboarding-complete users — never gated regardless of other fields.
assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: "2026-05-01T00:00:00Z",
    invited_by: null,
    tenant_id: "any-tenant",
  }),
  null,
  "completed onboarding: no redirect even with attachment",
);

assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: "2026-05-01T00:00:00Z",
    invited_by: "some-uuid",
    tenant_id: null,
  }),
  null,
  "completed onboarding overrides everything else",
);

// THE LOAD-BEARING REGRESSION TEST. A tenant-attached invitee with
// onboarding_completed_at still null (e.g. Alex/Jordan post-repair
// before backfill, or any future invitee in the same window) must NOT
// be redirected. Before the May 29 fix this returned /onboarding/welcome
// — which then auto-redirected to /t/<slug>, but only because the page
// itself had its own escape hatch. The middleware would still loop
// the user through an extra redirect cycle and break tenant-pinned
// session cookies. Tenant_id set is the authoritative "you have a
// workspace" signal; never gate when it's set.
assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: null,
    invited_by: "inviter-uuid",
    tenant_id: "sunbiz-uuid",
  }),
  null,
  "tenant-attached invitee with null onboarding_completed_at: NO redirect",
);

assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: null,
    invited_by: null,
    tenant_id: "sunbiz-uuid",
  }),
  null,
  "tenant-attached fresh-wizard completer with null timestamp: NO redirect",
);

// Genuine orphan invitee — has invited_by but redemption failed
// (tenant_id missing). Welcome page handles orphan recovery on render.
assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: null,
    invited_by: "inviter-uuid",
    tenant_id: null,
  }),
  "/onboarding/welcome",
  "orphan invitee → /onboarding/welcome (page runs recovery)",
);

// Genuine fresh-tenant signup — no invitation, no attachment yet.
assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: null,
    invited_by: null,
    tenant_id: null,
  }),
  "/onboarding/wizard",
  "fresh signup → /onboarding/wizard (industry template flow)",
);

console.log("Onboarding gate tests passed");
