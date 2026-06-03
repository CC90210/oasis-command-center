import assert from "node:assert/strict";

// Phase 3 (2026-06-02): the dashboard defaults to DRY-RUN for every outbound
// path. This locks the gate semantics so a refactor can't accidentally flip
// the dashboard to live-by-default.

import { isDryRun } from "../lib/integrations/send-mode";

const origForce = process.env.BRAVO_FORCE_DRY_RUN;
const origLive = process.env.DASHBOARD_LIVE_SEND;

function reset() {
  delete process.env.BRAVO_FORCE_DRY_RUN;
  delete process.env.DASHBOARD_LIVE_SEND;
}

// Case 1 — no env set → dry-run (fail-safe default).
reset();
assert.equal(isDryRun(), true, "default with no env is dry-run");

// Case 2 — explicit live opt-in → not dry-run.
reset();
process.env.DASHBOARD_LIVE_SEND = "1";
assert.equal(isDryRun(), false, "DASHBOARD_LIVE_SEND=1 enables live sends");

// Case 3 — force flag overrides live opt-in → dry-run.
reset();
process.env.DASHBOARD_LIVE_SEND = "1";
process.env.BRAVO_FORCE_DRY_RUN = "1";
assert.equal(isDryRun(), true, "BRAVO_FORCE_DRY_RUN=1 clamps back to dry-run even when live");

// Case 4 — live flag set to anything other than "1" → still dry-run.
reset();
process.env.DASHBOARD_LIVE_SEND = "true";
assert.equal(isDryRun(), true, "only the exact value '1' enables live");

// Restore the original environment.
reset();
if (origForce !== undefined) process.env.BRAVO_FORCE_DRY_RUN = origForce;
if (origLive !== undefined) process.env.DASHBOARD_LIVE_SEND = origLive;

console.log("ok dashboard-send-mode");
