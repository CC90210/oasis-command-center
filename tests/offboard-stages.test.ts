/**
 * tests/offboard-stages.test.ts — who can still be reached after their file
 * closes.
 *
 * This relaxes a guard Adon set on 2026-08-11, so the scope is the thing under
 * test. That rule exists because the board showed 6 leads in Signed Application
 * while the drip query was mailing 312, and 64% of all drip mail ever sent had
 * gone to people the board does not show.
 *
 * The exception is DECLINED and only declined: a declined lead is stamped
 * transferred_at and drops off the board, which is right for the board and
 * wrong for a one-month check-back. Measured 2026-08-18, all 57 emailable
 * declined leads were off-board, so that sequence was enabled and reaching
 * nobody.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { offboardStages, stageDripsOffBoard } from "../lib/drips/offboard-stages-core";

const NO_ENV: Record<string, string | undefined> = {};

// ── Declined, and nothing else ────────────────────────────────────────────
assert.equal(stageDripsOffBoard("declined", NO_ENV), true);
assert.equal(stageDripsOffBoard("Declined", NO_ENV), true, "case must not matter");
assert.equal(stageDripsOffBoard("  declined  ", NO_ENV), true, "nor padding");

// SIGNED_APPLICATION IS THE ONE THAT MUST STAY CLOSED. Adon, 2026-08-18: "there
// is no need for them to keep on receiving drips if we've shopped out their
// application because we received all the information that we need." The audit
// went further: 324 of the 331 emailable signed-application leads already have
// bank statements in application_underwriting, so re-opening that sequence
// would email 324 merchants asking for documents we already hold.
for (const stage of [
  "signed_application", "viewed_application", "sent_application",
  "follow_up", "uw_sheet", "funded", "approved", "dead_file", "default",
]) {
  assert.equal(stageDripsOffBoard(stage, NO_ENV), false, `${stage} must keep the board rule`);
}
assert.equal(stageDripsOffBoard("", NO_ENV), false);
assert.equal(stageDripsOffBoard(null, NO_ENV), false);
assert.equal(stageDripsOffBoard(undefined, NO_ENV), false);

// ── Overridable, and fails back rather than silently closing ─────────────
// An empty list re-closes re-engagement with no error, which is exactly how the
// declined sequence sat enabled and unreachable in the first place.
assert.deepEqual(offboardStages(NO_ENV), ["declined"]);
assert.deepEqual(offboardStages({ DRIP_OFFBOARD_STAGES: "declined,dead_file" }), ["declined", "dead_file"]);
for (const junk of ["", "   ", ",,,"]) {
  assert.deepEqual(offboardStages({ DRIP_OFFBOARD_STAGES: junk }), ["declined"], `"${junk}" falls back`);
}
// Turning it off entirely takes the literal word, which cannot be typed by
// accident.
assert.deepEqual(offboardStages({ DRIP_OFFBOARD_STAGES: "none" }), []);
assert.equal(stageDripsOffBoard("declined", { DRIP_OFFBOARD_STAGES: "none" }), false);

// An override REPLACES the default rather than adding to it, so a narrowed list
// really narrows.
assert.equal(stageDripsOffBoard("declined", { DRIP_OFFBOARD_STAGES: "dead_file" }), false);

// ── The enroller applies it in BOTH places ────────────────────────────────
// The board rule lives in the query AND in a belt-and-braces per-lead check.
// Loosening only the query would leave the belt rejecting exactly the leads the
// braces were loosened for — the sequence would still reach nobody, and the run
// report would blame "off_board".
{
  const enroller = readFileSync(new URL("../lib/drips/enroller.ts", import.meta.url), "utf8");
  assert.ok(
    enroller.includes("const offBoardOk = stageDripsOffBoard(stage);"),
    "the query must exempt the stage",
  );
  assert.ok(
    enroller.includes("offBoardOk ? qq : applyLeadsBoardFilter(qq)"),
    "and skip the board filter for it",
  );
  assert.ok(
    enroller.includes('if (!isOnLeadsBoard(data) && !stageDripsOffBoard(stage)) return "off_board";'),
    "the per-lead guard must carry the same exemption",
  );
  // Keyed on the SEQUENCE's trigger stage, not the lead's own field, so a
  // declined lead cannot slip into another stage's sequence off-board.
  assert.ok(
    !enroller.includes("stageDripsOffBoard(data.stage)"),
    "the exemption is scoped to the sequence's stage, never the lead's",
  );
}

console.log("offboard-stages.test.ts — all assertions passed");
