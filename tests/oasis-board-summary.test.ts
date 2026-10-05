/**
 * tests/oasis-board-summary.test.ts — Today's pipeline tiles come from the
 * board's own counts (2026-09-24). Run:
 *   node --conditions=react-server --import tsx tests/oasis-board-summary.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeBoardCounts } from "../lib/oasis-board-summary-rules";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";
import { MEETING_STAGES, WON_STAGES } from "../lib/oasis-board-summary-rules";

const s = summarizeBoardCounts(
  {
    assigned: 4,
    connected: 20,
    qualified: 3,
    founder_meeting_booked: 4,
    proposal_sent: 1,
    won: 1,
    launched: 2,
    lost: 7,
  },
  "2026-09-23T06:00:00.000Z",
);
assert.deepEqual(s, {
  onBoard: 35,
  qualified: 3,
  meetings: 5,
  won: 3,
  lost: 7,
  cycleStartedAt: "2026-09-23T06:00:00.000Z",
});
assert.equal(summarizeBoardCounts({}, "x").onBoard, 0, "an empty board is zero, not an error");

// Every grouping key is a real lifecycle stage — a renamed stage must fail here.
for (const key of [...WON_STAGES, ...MEETING_STAGES]) {
  assert.ok(OASIS_LEAD_STAGE_KEYS.includes(key), `${key} is not an OASIS lead stage`);
}

// Wiring: the summary runs the board's query with the board's cycle.
const src = readFileSync("lib/oasis-board-summary.ts", "utf8");
assert.match(src, /listOasisPipelineWindow\(/);
assert.match(src, /cycle: CURRENT_OASIS_PIPELINE_CYCLE/);
assert.match(src, /oasisBoardProgramFilter\(tenantSlug\)/);

console.log("oasis-board-summary: all assertions passed");
