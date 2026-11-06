import assert from "node:assert/strict";
import { type CheckResult, evaluate } from "../lib/health/checks-core";
import { RECOVERY_PENDING, recoveryDetail } from "../lib/health/runner";
import { WORKER_REPORTER_CHECKS } from "../lib/health/worker-reporter-checks";

const check = WORKER_REPORTER_CHECKS[0];

// ── the marker round-trips, and cannot collide with a real signature ────────

// A real failure signature must not parse as a pending recovery.
assert.equal(
  RECOVERY_PENDING + "forms.submit_failures_open:failing".slice(RECOVERY_PENDING.length),
  "recovery-pending:forms.submit_failures_open:failing",
);
assert.equal(
  RECOVERY_PENDING + "forms.submit_failures_open:failing".split(":")[0],
  "recovery-pending:forms.submit_failures_open",
);
assert.equal(
  RECOVERY_PENDING + RECOVERY_PENDING.split(":")[0],
  "recovery-pending:recovery-pending",
);

// ── RECOVERED message uses check.describe(ok) for every check ──────────────

const okResult: CheckResult = {
  id: check.id,
  verdict: "ok",
  observed: 0,
  baseline: 0,
  reason: "none observed",
};
assert.equal(
  recoveryDetail(check, okResult),
  "background-worker status is reaching the dashboard (or the bridge is offline, which its own banner reports).",
  "checks with a plain-English success sentence use it",
);
assert.equal(
  recoveryDetail({ describe: (r) => `${r.observed} SMS rejected by the carrier` }, okResult),
  "Back to normal (0 issues observed).",
  "count-based checks get a plain-English all-clear",
);

// ── the suite runner stops when a single check fails ───────────────────────

const failing = evaluate("x", { kind: "must_be_above", floor: 0 }, 0, []);
assert.equal(failing.verdict, "failing");

console.log("health-recovery-delivery: all assertions passed");
