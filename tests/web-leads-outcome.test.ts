import assert from "node:assert";
import {
  nextStage,
  isCallOutcome,
  CALL_OUTCOMES,
  MAX_CALL_NOTE_LENGTH,
  isCallOutcomeRequestId,
  outcomeContextSuperseded,
  outcomeTouchAlreadyApplied,
  validateCallOutcomeNote,
  type CallOutcome,
} from "../lib/web-leads/outcome";
import { WEBSITE_SALES_STAGES } from "../lib/website-sales";

// ---------------------------------------------------------------------------
// Build C (2026-08-21 leads-to-pipeline-design.md, section 5): logging the
// outcome IS the transfer to the pipeline, and nextStage() is the ONLY place
// that decides how far a stage may move. It is deliberately restricted to
// the early funnel because CC's engine owns the full lifecycle. Once contact
// is made, Pipeline's explicit lifecycle actions own qualification and the
// founder-meeting handoff. These tests pin every constraint the spec names so
// a future edit cannot loosen this quietly.
// ---------------------------------------------------------------------------

const ALL_OUTCOMES: readonly CallOutcome[] = CALL_OUTCOMES;
const ALL_STAGES: readonly string[] = WEBSITE_SALES_STAGES;
const CONNECTED_INDEX = ALL_STAGES.indexOf("connected");
assert.ok(CONNECTED_INDEX >= 0, "WEBSITE_SALES_STAGES must contain 'connected'");

// ---------------------------------------------------------------------------
// A real first attempt moves a researched/assigned lead into Attempting
// Contact. It never advances a lead already in that phase or later.
// ---------------------------------------------------------------------------
assert.equal(nextStage("researched", "no_answer"), "attempting_contact");
assert.equal(nextStage("assigned", "no_answer"), "attempting_contact");
for (const current of ["attempting_contact", ...ALL_STAGES.slice(CONNECTED_INDEX), null, undefined, "not_a_real_stage"]) {
  assert.equal(nextStage(current, "no_answer"), null, `no_answer must not over-advance ${String(current)}`);
}

// ---------------------------------------------------------------------------
// No stage beyond {connected, lost} can EVER be produced. This is asserted
// exhaustively across every real stage, every outcome, plus null/undefined
// and an unrecognized stage -- not spot-checked -- because nextStage's
// return type is a plain union, but a future edit could still widen the
// runtime values it returns.
// ---------------------------------------------------------------------------
const ALLOWED_RESULTS = new Set([null, "attempting_contact", "connected", "lost"]);
for (const current of [...ALL_STAGES, null, undefined, "not_a_real_stage"]) {
  for (const outcome of ALL_OUTCOMES) {
    const result = nextStage(current, outcome);
    assert.ok(
      ALLOWED_RESULTS.has(result),
      `nextStage(${String(current)}, ${outcome}) produced "${result}", which is not an allowed early-funnel result`,
    );
    // Never any of CC's downstream-only stages, named explicitly per the spec.
    for (const forbidden of ["qualified", "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "onboarding", "in_build", "client_review", "launched"]) {
      assert.notEqual(result, forbidden, `nextStage must never produce "${forbidden}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// connected / interested both land on "connected", only from BEFORE
// connected in the funnel.
// ---------------------------------------------------------------------------
for (const current of ["researched", "assigned", "attempting_contact"]) {
  assert.equal(nextStage(current, "connected"), "connected", `connected from ${current} must advance to connected`);
  assert.equal(nextStage(current, "interested"), "connected", `interested from ${current} must advance to connected (the qualification call is CC's, not ours)`);
}

// ---------------------------------------------------------------------------
// FORWARD ONLY: a lead already at "connected" logging "connected" (or
// "interested") again must not move it backwards -- it is a no-op, exactly
// as the spec requires.
// ---------------------------------------------------------------------------
assert.equal(nextStage("connected", "connected"), null, "already-connected + connected must be a no-op, never backwards");
assert.equal(nextStage("connected", "interested"), null, "already-connected + interested must be a no-op, never backwards");

// ---------------------------------------------------------------------------
// A lead CC has already moved PAST connected must never be touched by this
// build again, for ANY outcome -- this is what keeps a rep's stray
// "not interested" from ever writing "lost" over a deal that is already
// qualified, in proposal, won, or onboarding.
// ---------------------------------------------------------------------------
for (const current of ["qualified", "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "lost", "onboarding", "in_build", "client_review", "launched"]) {
  for (const outcome of ALL_OUTCOMES) {
    assert.equal(
      nextStage(current, outcome),
      null,
      `nextStage(${current}, ${outcome}) must be null -- this build never touches a lead past "connected"`,
    );
  }
}

// ---------------------------------------------------------------------------
// not_interested lands on "lost", from anywhere in the early funnel
// (including "connected" itself -- the call can go badly right after
// connecting).
// ---------------------------------------------------------------------------
for (const current of ["researched", "assigned", "attempting_contact", "connected"]) {
  assert.equal(nextStage(current, "not_interested"), "lost", `not_interested from ${current} must advance to lost`);
}

// ---------------------------------------------------------------------------
// No starting stage (null/undefined/unrecognized) is never guess-advanced.
// ---------------------------------------------------------------------------
for (const current of [null, undefined, "not_a_real_stage"]) {
  for (const outcome of ALL_OUTCOMES) {
    assert.equal(nextStage(current, outcome), null, `an unrecognized current stage (${String(current)}) must never be advanced`);
  }
}

// ---------------------------------------------------------------------------
// isCallOutcome / CALL_OUTCOMES -- the route's body validator.
// ---------------------------------------------------------------------------
for (const o of CALL_OUTCOMES) assert.ok(isCallOutcome(o), `${o} must be a valid CallOutcome`);
for (const bad of ["reached", "voicemail", "won", "", null, undefined, 42, {}]) {
  assert.equal(isCallOutcome(bad), false, `${JSON.stringify(bad)} must not be accepted as a CallOutcome`);
}

// A rejection closes the lead, so the handoff cannot be saved without the
// reason. Validation trims but never silently truncates the operator's note.
assert.deepEqual(validateCallOutcomeNote("not_interested", undefined), { ok: false, error: "reason_required" });
assert.deepEqual(validateCallOutcomeNote("not_interested", "   "), { ok: false, error: "reason_required" });
assert.deepEqual(validateCallOutcomeNote("not_interested", "  Budget frozen  "), { ok: true, note: "Budget frozen" });
assert.deepEqual(validateCallOutcomeNote("connected", undefined), { ok: true, note: null });
assert.deepEqual(validateCallOutcomeNote("connected", "  Follow up Tuesday  "), { ok: true, note: "Follow up Tuesday" });
assert.deepEqual(
  validateCallOutcomeNote("not_interested", "x".repeat(MAX_CALL_NOTE_LENGTH + 1)),
  { ok: false, error: "note_too_long" },
);
assert.deepEqual(
  validateCallOutcomeNote("not_interested", `  ${"x".repeat(MAX_CALL_NOTE_LENGTH)}  `),
  { ok: true, note: "x".repeat(MAX_CALL_NOTE_LENGTH) },
);

// Client-stable idempotency keys are UUIDs. Unknown, empty, or malformed
// values fail closed before any durable call row is written.
assert.equal(isCallOutcomeRequestId("9b210dce-630b-4b5f-8da2-60b30f03f7ad"), true);
for (const bad of [null, undefined, "", "not-a-uuid", "9b210dce-630b-4b5f-8da2-60b30f03f7ag", 42]) {
  assert.equal(isCallOutcomeRequestId(bad), false, `${JSON.stringify(bad)} is not a valid request id`);
}

// A replay at the same timestamp, or after a newer real call, must not rewrite
// the lead context/stage. An older timestamp means this durable outcome still
// needs its lead patch resumed.
assert.equal(outcomeTouchAlreadyApplied("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:00.000Z"), true);
assert.equal(outcomeTouchAlreadyApplied("2026-08-25T12:00:01.000Z", "2026-08-25T12:00:00.000Z"), true);
assert.equal(outcomeTouchAlreadyApplied("2026-08-25T11:59:59.000Z", "2026-08-25T12:00:00.000Z"), false);
assert.equal(outcomeTouchAlreadyApplied(null, "2026-08-25T12:00:00.000Z"), false);
assert.equal(outcomeContextSuperseded("2026-08-25T12:00:01.000Z", "2026-08-25T12:00:00.000Z"), true);
assert.equal(outcomeContextSuperseded("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:00.000Z"), false);
assert.equal(outcomeContextSuperseded("2026-08-25T11:59:59.000Z", "2026-08-25T12:00:00.000Z"), false);

console.log("web-leads-outcome ok");
