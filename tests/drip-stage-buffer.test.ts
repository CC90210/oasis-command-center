import assert from "node:assert/strict";
import { computeStep0DelayMinutes, enrollmentBufferForStage, stageBufferMinutes } from "../lib/drips/stage-buffer";
import { selectStaleRunIds, triggerStageOf } from "../lib/drips/stage-cancel";

// 24h stage-buffer + eager-cancel fix (2026-07-22). Locks the three rules:
// (1) step-0 of a stage sequence never fires before the buffer; (2) a stage
// change flushes exactly the OTHER stages' pending runs; (3) flag-triggered
// and unknown-sequence runs are never touched by the stage debounce.

// --- computeStep0DelayMinutes: buffer is a FLOOR, never a ceiling ---
assert.equal(computeStep0DelayMinutes(10, 1440), 1440, "short delay floored to 24h");
assert.equal(computeStep0DelayMinutes(2880, 1440), 2880, "longer sequence delay wins");
assert.equal(computeStep0DelayMinutes(-5, 1440), 1440, "negative delay clamps to buffer");
assert.equal(computeStep0DelayMinutes(30, 0), 30, "buffer disabled -> own delay");
assert.equal(computeStep0DelayMinutes(0, 0), 0, "both zero -> immediate");

// --- stageBufferMinutes env parsing (default 1440, fail-safe fallbacks) ---
const priorEnv = process.env.DRIPS_STAGE_BUFFER_MIN;
delete process.env.DRIPS_STAGE_BUFFER_MIN;
assert.equal(stageBufferMinutes(), 1440, "unset -> 24h default");
process.env.DRIPS_STAGE_BUFFER_MIN = "60";
assert.equal(stageBufferMinutes(), 60, "explicit minutes honored");
process.env.DRIPS_STAGE_BUFFER_MIN = "-10";
assert.equal(stageBufferMinutes(), 0, "negative clamps to 0");
assert.equal(computeStep0DelayMinutes(10, stageBufferMinutes()), 10, "0 buffer keeps own delay");
process.env.DRIPS_STAGE_BUFFER_MIN = "abc";
assert.equal(stageBufferMinutes(), 1440, "non-numeric -> default");
process.env.DRIPS_STAGE_BUFFER_MIN = "  ";
assert.equal(stageBufferMinutes(), 1440, "blank -> default (Number('')===0 trap)");
process.env.DRIPS_STAGE_BUFFER_MIN = "90.9";
assert.equal(stageBufferMinutes(), 90, "fractional floors");

process.env.DRIPS_STAGE_BUFFER_MIN = "1440";
assert.equal(enrollmentBufferForStage("sent_application"), 0, "sent application access is immediate");
assert.equal(enrollmentBufferForStage("follow_up"), 1440, "other stages retain the safety buffer");
if (priorEnv === undefined) delete process.env.DRIPS_STAGE_BUFFER_MIN;
else process.env.DRIPS_STAGE_BUFFER_MIN = priorEnv;

// --- triggerStageOf: only well-formed stage filters count ---
assert.equal(
  triggerStageOf({ entity: "lead", field: "stage", to: "signed_application" }),
  "signed_application",
  "stage filter parsed",
);
assert.equal(triggerStageOf({ field: "accelerated_followup", to: "1" }), null, "flag filter -> null");
assert.equal(triggerStageOf(null), null, "null filter -> null");
assert.equal(triggerStageOf({ field: "stage", to: "" }), null, "empty stage -> null");
assert.equal(triggerStageOf("stage"), null, "non-object -> null");
// Canonical-definition parity (codex P1): the engine treats omitted field/
// entity as stage/lead defaults — the cancel helper must match, or those
// sequences survive stage changes uncancelled.
assert.equal(triggerStageOf({ to: "follow_up" }), "follow_up", "omitted field+entity -> stage-triggered");
assert.equal(triggerStageOf({ entity: "lead", to: "signed_application" }), "signed_application", "omitted field -> stage-triggered");
assert.equal(triggerStageOf({ entity: "application", field: "stage", to: "shopping" }), null, "application-keyed filter is NOT lead-stage");
assert.equal(triggerStageOf({ to: "  follow_up  " }), "follow_up", "stage trimmed like the engine");

// --- selectStaleRunIds: the debounce partition ---
const SEQS = [
  { id: "seq-signed", trigger_filter: { entity: "lead", field: "stage", to: "signed_application" } },
  { id: "seq-follow", trigger_filter: { entity: "lead", field: "stage", to: "follow_up" } },
  { id: "seq-chase", trigger_filter: { field: "accelerated_followup" } },
];
const RUNS = [
  { id: "r-signed", sequence_id: "seq-signed" },
  { id: "r-follow", sequence_id: "seq-follow" },
  { id: "r-chase", sequence_id: "seq-chase" },
  { id: "r-orphan", sequence_id: "seq-deleted" },
];

assert.deepEqual(
  selectStaleRunIds(RUNS, SEQS, "signed_application"),
  ["r-follow"],
  "lead now signed: only the follow_up-stage run is stale; matching/flag/orphan kept",
);
assert.deepEqual(
  selectStaleRunIds(RUNS, SEQS, "sent_application"),
  ["r-signed", "r-follow"],
  "lead at a third stage: both other stages' runs stale",
);
assert.deepEqual(
  selectStaleRunIds(RUNS, SEQS, null),
  ["r-signed", "r-follow"],
  "shopped-out (null stage): every STAGE-triggered run stale, flag chase kept",
);
assert.deepEqual(selectStaleRunIds([], SEQS, "follow_up"), [], "no runs -> nothing");
// Rapid double-bounce A->B->A: after the bounce back, the A-stage run (freshly
// re-enrolled) matches again and must NOT be cancelled.
assert.deepEqual(
  selectStaleRunIds(
    [{ id: "r-signed-2", sequence_id: "seq-signed" }],
    SEQS,
    "signed_application",
  ),
  [],
  "re-entered stage keeps its own fresh run",
);

console.log("drip-stage-buffer: ALL PASS");
