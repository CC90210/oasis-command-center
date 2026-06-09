import assert from "node:assert/strict";
import {
  BRIDGE_HEALTH_REASONS,
  isBridgeHealthReason,
  type BridgeHealthReason,
} from "../lib/bridge-health-types";

// Codex round-7 [medium] regression lock: profile_lookup_failed used to
// fall through to vps_unreachable because the reason type didn't include
// it. That misdirected operators to debug DNS/TLS when the broken leg
// was Supabase. This test pins the full set of reasons that
// authorizeBridgeRequest can emit, so a future error-string addition
// either gets added here too or fails this test loudly.
//
// Source of truth for emitted errors: lib/bridge-proxy.ts
//   authorizeBridgeRequest returns { ok: false, status, error: <string> }
//   on every failure path. The error strings as of 2026-06-09 round-7:
const AUTH_REQUEST_ERROR_STRINGS = [
  "unauthenticated",          // line 77
  "no_profile",               // line 92
  "profile_lookup_failed",    // line 100  ← round-7 add
  "no_tenant",                // line 102
  "tenant_lookup_failed",     // line 115
  "bridge_not_enabled_for_tenant", // line 118
  "bridge_not_configured",    // line 122
];

// Every authorizeBridgeRequest error string MUST round-trip through
// isBridgeHealthReason — otherwise the route's narrow collapses it to
// vps_unreachable and the operator gets sent down the wrong fix path.
for (const err of AUTH_REQUEST_ERROR_STRINGS) {
  assert.ok(
    isBridgeHealthReason(err),
    `authorizeBridgeRequest emits "${err}" — must be in BRIDGE_HEALTH_REASONS so the diagnostic JSON surfaces it instead of collapsing to vps_unreachable`,
  );
}

// And the VPS-side reasons set by the route handler itself:
const ROUTE_EMITTED_REASONS: BridgeHealthReason[] = [
  "ok",
  "vps_timeout",
  "vps_unauthorized",
  "vps_upstream_error",
  "vps_unreachable",
];
for (const r of ROUTE_EMITTED_REASONS) {
  assert.ok(
    BRIDGE_HEALTH_REASONS.includes(r),
    `route emits "${r}" — must be in BRIDGE_HEALTH_REASONS`,
  );
}

// Sanity: isBridgeHealthReason rejects strings that aren't in the set.
assert.equal(isBridgeHealthReason("totally_made_up"), false);
assert.equal(isBridgeHealthReason(""), false);

// The frozen tuple length matches the literal-union size — single source
// of truth check. (If you add a reason, add it to both, or this fails.)
assert.equal(
  BRIDGE_HEALTH_REASONS.length,
  new Set(BRIDGE_HEALTH_REASONS).size,
  "BRIDGE_HEALTH_REASONS must have unique entries",
);

console.log("bridge-health-reasons.test.ts: OK");
