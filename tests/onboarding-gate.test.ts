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

// No workspace and no invitation. 2026-09-30: this used to go to the wizard,
// which now serves only a workspace owner and refuses an account with no
// workspace; its refusal page's link to "/" was sent straight back, a loop on
// every page until the next login. "/" explains the account is not linked.
assert.equal(
  shouldRedirectToOnboarding({
    onboarding_completed_at: null,
    invited_by: null,
    tenant_id: null,
  }),
  null,
  "no workspace, no invite → no redirect (the wizard cannot serve them)",
);

// 2026-09-30: the OWNER of a workspace that is not set up yet may set it up
// themselves, so the gate sends them to the wizard. Only a positive "not set
// up" does: an unknown answer never traps anyone, and a member never goes.
assert.equal(
  shouldRedirectToOnboarding(
    { onboarding_completed_at: null, invited_by: "inviter", tenant_id: "acme", is_owner: 1 },
    { workspaceProvisioned: false },
  ),
  "/onboarding/wizard",
  "owner of an unprovisioned workspace -> wizard",
);
assert.equal(
  shouldRedirectToOnboarding(
    { onboarding_completed_at: null, invited_by: "inviter", tenant_id: "acme", is_owner: 1 },
    { workspaceProvisioned: true },
  ),
  null,
  "owner of a set-up workspace lands in it",
);
assert.equal(
  shouldRedirectToOnboarding(
    { onboarding_completed_at: null, invited_by: "inviter", tenant_id: "acme", is_owner: 1 },
    { workspaceProvisioned: null },
  ),
  null,
  "unknown provisioning state never gates",
);
assert.equal(
  shouldRedirectToOnboarding(
    { onboarding_completed_at: null, invited_by: "inviter", tenant_id: "acme", is_owner: 0 },
    { workspaceProvisioned: false },
  ),
  null,
  "a member of an unprovisioned workspace is never sent to the wizard",
);

console.log("Onboarding gate tests passed");
