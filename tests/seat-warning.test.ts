/**
 * Real runtime tests for lib/seat-warning-policy — the pure logic
 * extracted from lib/seat-warning (which can't be Node-imported
 * because it has `import "server-only"`). Locks the
 * SunBiz #7 product-decision behavior with assertions, not just
 * type contracts.
 */

import assert from "node:assert/strict";
import {
  classifySeatUsage,
  getSeatLimitForPlan,
  SEAT_LIMITS_BY_PLAN,
  type SeatWarning,
} from "../lib/seat-warning-policy";

// Plan-limit lookups
assert.equal(getSeatLimitForPlan("free"), 1);
assert.equal(getSeatLimitForPlan("starter"), 3);
assert.equal(getSeatLimitForPlan("growth"), 10);
assert.equal(getSeatLimitForPlan("pro"), 25);
assert.equal(getSeatLimitForPlan("enterprise"), null, "enterprise has no soft cap");
assert.equal(getSeatLimitForPlan("custom"), null, "unknown plan = no cap");
assert.equal(getSeatLimitForPlan(null), null, "null plan = no cap");
assert.equal(getSeatLimitForPlan(undefined), null, "undefined plan = no cap");

// classifySeatUsage: ok states
const ok1: SeatWarning | null = classifySeatUsage({ used: 1, planTier: "starter" });
assert.equal(ok1?.status, "ok");
assert.equal(ok1?.limit, 3);
assert.equal(ok1?.used, 1);

const ok2 = classifySeatUsage({ used: 2, planTier: "starter" });
assert.equal(ok2?.status, "ok", "starter, used=2 (limit-1) is still ok");

// approaching: at the limit, one more would over
const approaching = classifySeatUsage({ used: 3, planTier: "starter" });
assert.equal(approaching?.status, "approaching");
assert.match(approaching!.message, /3 of 3 seats used/);

// over: above the limit
const over = classifySeatUsage({ used: 5, planTier: "starter" });
assert.equal(over?.status, "over");
assert.match(over!.message, /over the starter plan limit/);

// SunBiz today is on starter with 3 users → approaching
// (locked here so a future plan-tier sizing change is caught)
assert.equal(
  classifySeatUsage({ used: 3, planTier: "starter" })?.status,
  "approaching",
  "SunBiz starter+3-users sees the approaching banner",
);

// Enterprise / unknown / null → null (no cap = no warning)
assert.equal(classifySeatUsage({ used: 100, planTier: "enterprise" }), null);
assert.equal(classifySeatUsage({ used: 5, planTier: null }), null);
assert.equal(classifySeatUsage({ used: 5, planTier: undefined }), null);
assert.equal(classifySeatUsage({ used: 5, planTier: "custom" }), null);

// Hardening: negative / fractional used values get coerced sanely
assert.equal(
  classifySeatUsage({ used: -1, planTier: "starter" })?.used,
  0,
  "negative used coerces to 0",
);
assert.equal(
  classifySeatUsage({ used: 2.7, planTier: "starter" })?.used,
  2,
  "fractional used floors",
);

// SEAT_LIMITS_BY_PLAN is exported as readonly — the runtime constant
// shape is what we lock here; the readonly tag is enforced by tsc.
assert.equal(SEAT_LIMITS_BY_PLAN.starter, 3);
assert.equal(SEAT_LIMITS_BY_PLAN.pro, 25);

console.log("seat-warning ok (16 cases)");
