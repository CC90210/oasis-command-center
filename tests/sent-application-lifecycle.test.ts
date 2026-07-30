import assert from "node:assert/strict";
import { selectStaleRunIds, triggerStageOf } from "../lib/drips/stage-cancel";
import { isReEntryEligible } from "../lib/drips/drip-rules-core";

/**
 * The sent_application lifecycle the SOP requires (items 5, 6, 9). This
 * behaviour already worked before the instant-send change; these are
 * characterization assertions so it cannot silently regress.
 *
 *   5. The CRM record persists while the application is incomplete.
 *   6. An incomplete application keeps its email/SMS reminder cadence.
 *   9. COMPLETING the application stops the incomplete-application reminders.
 */

const runs = [
  { id: "r-firsttouch", sequence_id: "s-firsttouch" },
  { id: "r-reminder", sequence_id: "s-reminder" },
];
const sequences = [
  { id: "s-firsttouch", trigger_filter: { entity: "lead", field: "stage", to: "sent_application" } },
  { id: "s-reminder", trigger_filter: { entity: "lead", field: "stage", to: "sent_application" } },
];

// SOP 6: an INCOMPLETE application keeps its reminder cadence.
assert.deepEqual(
  selectStaleRunIds(runs, sequences, "sent_application"),
  [],
  "a lead still at sent_application keeps every reminder queued",
);

// SOP 9: COMPLETING the application cancels the incomplete-app reminders.
assert.deepEqual(
  selectStaleRunIds(runs, sequences, "signed_application").sort(),
  ["r-firsttouch", "r-reminder"],
  "THE SOP REQUIREMENT: completing the application cancels its reminders",
);

// A shopped-out deal cancels every stage run.
assert.deepEqual(
  selectStaleRunIds(runs, sequences, null).sort(),
  ["r-firsttouch", "r-reminder"],
  "a shopped-out deal stops being nagged",
);

// Flag-triggered chases have their own lifecycle and must not be cancelled here.
const flagSeq = [
  { id: "s-flag", trigger_filter: { entity: "lead", field: "accelerated_followup", to: "true" } },
];
assert.equal(triggerStageOf(flagSeq[0].trigger_filter), null, "a flag trigger is not a stage trigger");
assert.deepEqual(
  selectStaleRunIds([{ id: "r-flag", sequence_id: "s-flag" }], flagSeq, "signed_application"),
  [],
  "a flag-triggered chase survives a stage change",
);

// An unknown sequence is left for the executor rather than cancelled blindly.
assert.deepEqual(
  selectStaleRunIds([{ id: "r-unknown", sequence_id: "s-missing" }], sequences, "signed_application"),
  [],
  "a run whose sequence is unknown is left alone, not cancelled",
);

// ── Duplicate prevention, layer 2: the COOLDOWN branch specifically ─────────
// Amended in after the Task 1 review (2026-07-30). The assertions added in
// Task 1 never reached the cooldown comparison: their "duplicate" input had
// stageEnteredAt BEFORE lastRunAtMs, so it failed the not-a-re-entry guard
// first, and the eligible case used a 30-day gap against a 7-day cooldown. The
// property Layer 2 actually provides — a GENUINE re-entry that is still inside
// the cooldown must NOT re-drip — was untested. It is the load-bearing layer
// for instant send, so it gets the boundary cases.

const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000;
const COOLDOWN = 7 * DAY;

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 1 * DAY,
    stageEnteredAt: new Date(NOW - 1 * 3_600_000).toISOString(), // re-entered AFTER the run
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "THE REAL LAYER-2 CASE: a genuine re-entry INSIDE the cooldown must not re-drip",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 8 * DAY,
    stageEnteredAt: new Date(NOW - 1 * 3_600_000).toISOString(),
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  true,
  "a genuine re-entry just PAST the cooldown is eligible",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 3 * DAY,
    stageEnteredAt: new Date(NOW - 4 * DAY).toISOString(), // never re-entered
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "a lead PARKED in the stage never re-drips, regardless of the cooldown",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 30 * DAY,
    stageEnteredAt: undefined, // historical lead, column never stamped
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "absent stage_entered_at reads as 'not a re-entry', so the back catalogue is never re-dripped",
);

console.log("sent-application-lifecycle.test.ts — all assertions passed ✓");
