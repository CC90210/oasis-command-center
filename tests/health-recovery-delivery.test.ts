/**
 * tests/health-recovery-delivery.test.ts — a recovery nobody received is an
 * incident that never closed.
 *
 * A failure alert can afford to lose a lane. The decay ladder re-sends it, and
 * `alerting.telegram_delivery` turns a dead channel into an alert of its own.
 * A RECOVERY cannot: the runner clears `first_failed_at` and the episode is
 * over. There is no second attempt, ever.
 *
 * So the 2026-08-07 shape — @KnutRPEbot kicked from the sunbiz-ops group, every
 * send to that lane returning 403 — plays out like this if the recovery is
 * fire-and-forget:
 *
 *   1. drip check fails      → alert reaches BOTH lanes
 *   2. bot is kicked
 *   3. drip check recovers   → "RECOVERED" reaches operator, 403 on sunbiz-ops
 *   4. episode cleared       → sunbiz-ops keeps a red alert with nothing left
 *                              in the system that will ever resolve it
 *
 * The fix carries the unpaid lanes forward in `last_signature` and retries only
 * those. Retrying wholesale would be its own bug: a lane dead for days would
 * re-tell the REACHABLE audience "RECOVERED" every 15 minutes, ~96 times a day,
 * which is how people learn to mute the channel.
 *
 * `pendingRecoveryLanes` is exercised for real. The control flow around it is
 * asserted against the source, which is this file's established convention for
 * runner.ts (see tests/form-submit-failure-capture.test.ts) — the function
 * needs a live Supabase client and fifty checks to run end to end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pendingRecoveryLanes } from "../lib/health/runner";

const RUNNER = readFileSync("lib/health/runner.ts", "utf8");

// ── the marker round-trips, and cannot collide with a real signature ────────

// A live failure signature. Nothing about it may read as a pending recovery,
// or a genuine outage would be mistaken for an undelivered "all clear".
assert.equal(
  pendingRecoveryLanes("forms.submit_failures_open:failing"),
  null,
  "a real alert signature parses as a pending recovery — a live failure would be read as an all-clear",
);
assert.equal(pendingRecoveryLanes(null), null, "a cleared signature is not a pending recovery");
assert.equal(pendingRecoveryLanes(undefined), null, "a missing signature is not a pending recovery");
assert.equal(
  pendingRecoveryLanes("recovery-pending:"),
  null,
  "an empty lane list must fall back to every lane, not to none — none means silence",
);

assert.deepEqual(
  pendingRecoveryLanes("recovery-pending:sunbiz-ops"),
  ["sunbiz-ops"],
  "a single owed lane does not round-trip",
);
assert.deepEqual(
  pendingRecoveryLanes("recovery-pending:operator,sunbiz-ops"),
  ["operator", "sunbiz-ops"],
  "two owed lanes do not round-trip",
);

// The format the runner writes must be the format it reads. If these drift, a
// retry silently degrades to re-announcing to everyone, forever.
const MARKER = /const RECOVERY_PENDING = "recovery-pending:";/;
assert.match(RUNNER, MARKER, "the marker prefix moved without the parser");
assert.match(
  RUNNER,
  /last_signature: stillOwed\.length \? `\$\{RECOVERY_PENDING\}\$\{stillOwed\.join\(","\)\}` : null/,
  "the runner no longer writes the pending-lane marker the parser expects",
);

// ── the episode stays open while a lane is still owed the news ──────────────

assert.match(
  RUNNER,
  /first_failed_at: stillOwed\.length \? state\.first_failed_at : null/,
  "the episode is cleared unconditionally again — a lane that rejected the recovery can never be retried",
);
assert.doesNotMatch(
  RUNNER,
  /repeat_n: 0, first_failed_at: null,/,
  "the unconditional clear is back",
);

// ── only the lanes that did NOT accept are retried ──────────────────────────

assert.match(
  RUNNER,
  /const owed = pendingRecoveryLanes\(state\.last_signature\) \?\? lanesFor\(check\);/,
  "the retry no longer narrows to the owed lanes — the reachable audience gets 'RECOVERED' every 15 minutes",
);
assert.match(
  RUNNER,
  /for \(const lane of owed\) \{/,
  "the recovery loop no longer iterates the owed lanes",
);

// ── the send result is read, not discarded ─────────────────────────────────

assert.doesNotMatch(
  RUNNER,
  /\{ lane \},\s*\)\.catch\(\(\) => undefined\);/,
  "the recovery send's result is discarded again — a rejection becomes invisible",
);
assert.match(
  RUNNER,
  /if \(!r\.ok\) stillOwed\.push\(lane\);/,
  "a rejected lane is no longer recorded as still owed",
);

// ── an undelivered recovery is recorded where the dead channel cannot hide it

assert.match(
  RUNNER,
  /reason: `could not deliver the \$\{result\.id\} recovery to \$\{stillOwed\.join\(", "\)\}`/,
  "an undelivered recovery no longer writes a telegram_delivery row",
);

// ── the alert path names the lanes that actually rejected it ───────────────

// This line read "the sunbiz-ops lane" unconditionally: the same defect as the
// rest of the branch, a lane constant standing in for a lane decision. It sent
// anyone reading the row to the wrong chat.
assert.doesNotMatch(
  RUNNER,
  /alert to the sunbiz-ops lane/,
  "the delivery-failure row hardcodes sunbiz-ops again, whichever lane actually failed",
);
assert.match(
  RUNNER,
  /reason: `could not deliver the \$\{result\.id\} alert to \$\{rejected\.join\(", "\)\}`/,
  "the delivery-failure row no longer names the lanes that rejected it",
);

console.log("health-recovery-delivery: all assertions passed");
