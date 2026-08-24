import assert from "node:assert";
import { nextStage, isCallOutcome, CALL_OUTCOMES, type CallOutcome } from "../lib/web-leads/outcome";
import { WEBSITE_SALES_STAGES } from "../lib/website-sales";

// ---------------------------------------------------------------------------
// Build C (2026-08-21 leads-to-pipeline-design.md, section 5): logging the
// outcome IS the transfer to the pipeline, and nextStage() is the ONLY place
// that decides how far a stage may move. It is deliberately restricted to
// the early funnel because CC's engine owns the full lifecycle and we have
// not received a usable answer on the supported way to advance a stage
// (agent_activity row 5daa4bd1). These tests pin every constraint the spec
// names so a future edit cannot loosen this quietly.
//
// WIDENED 2026-08-23. The vocabulary went from four dispositions to eight, and
// the stage decision moved into lib/website-sales-workflow.ts so that BOTH
// call-logging paths share one implementation. nextStage() is now a thin
// narrowing wrapper over advanceStageForDisposition. Every safety property
// below is UNCHANGED and re-proved against the wider vocabulary -- that is the
// point of re-running them: a bigger vocabulary is exactly when a
// forward-only, early-funnel-only guard is most likely to spring a leak.
// ---------------------------------------------------------------------------

const ALL_OUTCOMES: readonly CallOutcome[] = CALL_OUTCOMES;
const ALL_STAGES: readonly string[] = WEBSITE_SALES_STAGES;
const CONNECTED_INDEX = ALL_STAGES.indexOf("connected");
assert.ok(CONNECTED_INDEX >= 0, "WEBSITE_SALES_STAGES must contain 'connected'");

// The eight are pinned by name. A silent removal would quietly re-narrow the
// screen; a silent addition would reach the DB CHECK constraint, which permits
// exactly this set (plus 'won', which this feature never writes).
assert.deepEqual(
  [...ALL_OUTCOMES].sort(),
  ["callback", "connected", "do_not_call", "gatekeeper", "interested", "no_answer", "not_interested", "voicemail"],
  "the call-disposition vocabulary must be exactly these eight",
);

// ---------------------------------------------------------------------------
// NO-CONTACT OUTCOMES NEVER CHANGE A STAGE -- from every real stage, an
// unknown stage, and no stage at all. A lead nobody reached has not changed
// state: it is still being attempted. This used to be true of `no_answer`
// alone; voicemail and gatekeeper join it, and getting either of those wrong
// would advance a lead nobody has actually spoken to.
// ---------------------------------------------------------------------------
for (const outcome of ["no_answer", "voicemail", "gatekeeper"] as const) {
  for (const current of [...ALL_STAGES, null, undefined, "not_a_real_stage"]) {
    assert.equal(
      nextStage(current, outcome),
      null,
      `${outcome} must never advance a stage (current=${String(current)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// No stage beyond {connected, lost} can EVER be produced. Asserted
// exhaustively across every real stage, every outcome, plus null/undefined
// and an unrecognized stage -- not spot-checked -- because nextStage's
// return type is a plain union, but a future edit could still widen the
// runtime values it returns.
// ---------------------------------------------------------------------------
const ALLOWED_RESULTS = new Set([null, "connected", "lost"]);
for (const current of [...ALL_STAGES, null, undefined, "not_a_real_stage"]) {
  for (const outcome of ALL_OUTCOMES) {
    const result = nextStage(current, outcome);
    assert.ok(
      ALLOWED_RESULTS.has(result),
      `nextStage(${String(current)}, ${outcome}) produced "${result}", which is not one of null/connected/lost`,
    );
    // Never any of CC's downstream-only stages, named explicitly per the spec.
    for (const forbidden of ["qualified", "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "onboarding", "in_build", "client_review", "launched"]) {
      assert.notEqual(result, forbidden, `nextStage must never produce "${forbidden}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// connected / interested / callback all land on "connected", only from BEFORE
// connected in the funnel.
//
// `callback` belongs with them and this is worth stating plainly: a prospect
// who named a time to be called back IS someone the rep got on the phone. The
// alternative reading -- that a callback is a failed attempt -- would leave
// those leads sitting in `attempting_contact` forever, invisible to every
// pipeline count, which is the same class of silent loss this whole change
// exists to remove.
// ---------------------------------------------------------------------------
for (const current of ["researched", "assigned", "attempting_contact"]) {
  assert.equal(nextStage(current, "connected"), "connected", `connected from ${current} must advance to connected`);
  assert.equal(nextStage(current, "interested"), "connected", `interested from ${current} must advance to connected (the qualification call is CC's, not ours)`);
  assert.equal(nextStage(current, "callback"), "connected", `callback from ${current} must advance to connected -- they were reached`);
}

// ---------------------------------------------------------------------------
// FORWARD ONLY: a lead already at "connected" logging "connected" (or
// "interested", or "callback") again must not move it backwards -- it is a
// no-op, exactly as the spec requires.
// ---------------------------------------------------------------------------
assert.equal(nextStage("connected", "connected"), null, "already-connected + connected must be a no-op, never backwards");
assert.equal(nextStage("connected", "interested"), null, "already-connected + interested must be a no-op, never backwards");
assert.equal(nextStage("connected", "callback"), null, "already-connected + callback must be a no-op, never backwards");

// ---------------------------------------------------------------------------
// A lead CC has already moved PAST connected must never be touched by this
// build again, for ANY outcome -- this is what keeps a rep's stray
// "not interested" from ever writing "lost" over a deal that is already
// qualified, in proposal, won, or onboarding.
//
// `do_not_call` is the newest and sharpest case: it is the one disposition a
// rep might reasonably expect to override everything, and it must NOT reach a
// won deal's stage. Suppressing future contact is handled by the do_not_call
// flag on the patch, not by dragging a live customer to `lost`.
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
// The terminal outcomes land on "lost", from anywhere in the early funnel
// (including "connected" itself -- the call can go badly right after
// connecting).
// ---------------------------------------------------------------------------
for (const current of ["researched", "assigned", "attempting_contact", "connected"]) {
  assert.equal(nextStage(current, "not_interested"), "lost", `not_interested from ${current} must advance to lost`);
  assert.equal(nextStage(current, "do_not_call"), "lost", `do_not_call from ${current} must advance to lost`);
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
//
// `voicemail` moved from the reject list to the accept list in this change,
// which is the whole point of it. `reached` stays rejected: it is the DATABASE
// spelling of connected, and accepting it at the API boundary would let two
// spellings of one disposition into the history table.
// ---------------------------------------------------------------------------
for (const o of CALL_OUTCOMES) assert.ok(isCallOutcome(o), `${o} must be a valid CallOutcome`);
for (const bad of ["reached", "won", "attempted", "lost", "", null, undefined, 42, {}]) {
  assert.equal(isCallOutcome(bad), false, `${JSON.stringify(bad)} must not be accepted as a CallOutcome`);
}

console.log("web-leads-outcome ok");
