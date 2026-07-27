import assert from "node:assert/strict";
import { clairEligibility, hasUsablePhone } from "../lib/clair/eligibility";

/**
 * CLAIR availability — the regression guard for the 2026-07-27 fix.
 *
 * The bug: a lead whose automated TruePeopleSearch lookup succeeded had the
 * "Pull CLAIR Report" button removed, and the API answered 409. That is exactly
 * backwards — the TPS number is frequently the WRONG number (stale landline, a
 * relative, a disconnected cell), so a found-but-wrong number is the case where
 * an operator most needs the manual fallback.
 *
 * These assertions pin that CLAIR is offered at every point in the lifecycle.
 * If one of them starts failing because someone re-added a phone-presence or
 * lookup-status precondition, that is the regression, not the test.
 *
 * NOTE ON WHAT IS *NOT* TESTED HERE: manual-only. CLEAR remains operator-
 * initiated because app/api/leads/[id]/clair-report/route.ts authenticates a
 * signed-in operator, gates on role, scopes to the tenant, and stamps
 * requested_by on the report row — there is no service-to-service caller and no
 * cron. Availability and authorization are different things; relaxing the first
 * does not touch the second. Do not "fix" a failure below by re-adding a gate
 * here — the compliance boundary is in the route.
 */

// --- hasUsablePhone: unchanged behaviour, still used by the TPS route + chips.

assert.equal(hasUsablePhone({ phone: "555-867-5309" }), true, "formatted 10-digit is usable");
assert.equal(hasUsablePhone({ phone: "0000000000" }), false, "0-filled live sub is an absence");
assert.equal(hasUsablePhone({ phone: "12345" }), false, "under 10 digits is not a number");
assert.equal(hasUsablePhone({}), false, "missing phone is not a number");
assert.equal(hasUsablePhone({ phone: null }), false, "null phone is not a number");

// --- clairEligibility: available regardless of phone or lookup state.

assert.equal(
  clairEligibility({ phone: "555-867-5309", phone_lookup_status: "found" }).eligible,
  true,
  "THE REPORTED BUG: a lead with a TPS-found phone must still offer CLAIR",
);

assert.equal(
  clairEligibility({ phone: "555-867-5309" }).eligible,
  true,
  "a phone on file from any source does not remove CLAIR",
);

assert.equal(
  clairEligibility({}).eligible,
  true,
  "CLAIR is available before the automated lookup has ever run",
);

assert.equal(
  clairEligibility({ phone_lookup_status: "manual_review" }).eligible,
  true,
  "lookup failed — CLAIR available (was already true, must stay true)",
);

assert.equal(
  clairEligibility({ phone_lookup_status: "not_found" }).eligible,
  true,
  "lookup found nothing — CLAIR available",
);

assert.equal(
  clairEligibility({ phone: "0000000000", phone_lookup_status: "" }).eligible,
  true,
  "0-filled live sub with no lookup yet — CLAIR available",
);

// An eligible result carries no operator-facing reason (the UI renders it only
// when it is refusing).
assert.equal(clairEligibility({ phone: "555-867-5309" }).reason, "", "eligible carries no reason");

console.log("clair-eligibility.test.ts — all assertions passed ✓");
