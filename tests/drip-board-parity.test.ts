/**
 * tests/drip-board-parity.test.ts — the drip audience IS the board's audience.
 *
 * Adon, 2026-08-11, looking at the live Leads tab while I quoted him a number
 * from the database: "There are no [291] merchants in signed applications. We
 * have a lot in viewed but not in signed. I don't know what you're talking
 * about."
 *
 * He was reading the truth and I was not. The Leads board hides any lead
 * stamped `transferred_at` (it has graduated to the Applications board); the
 * drip enroller queried `data->>stage` directly and never applied that rule.
 * Measured on production that day, SunBiz tenant:
 *
 *   stage                on the board   drip targeted
 *   signed_application             6             312
 *   viewed_application           175             190
 *   declined                       0              61
 *   dead_file                      0              30
 *   follow_up                    509             512
 *
 * 211 of 329 drip emails ever sent — 64% — had gone to merchants not on the
 * board, and 126 pending runs were queued to do it again.
 *
 * The rule lived as a duplicated string literal in two places, which is how it
 * drifted. These tests hold the rule itself AND the fact that both surfaces
 * import it from one module, because a second copy is what caused this.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isOnLeadsBoard,
  detectBoardExit,
  applyLeadsBoardFilter,
  LEADS_BOARD_OR_FILTER,
  LEADS_BOARD_EXEMPT_STAGE,
  BOARD_EXIT_FIELD,
} from "../lib/leads/board-visibility";
import { planDripCancellations } from "../lib/portals/stage-hooks";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

// Never transferred: the ordinary case, and the whole top of the funnel.
assert.equal(isOnLeadsBoard({ stage: "viewed_application" }), true);
assert.equal(isOnLeadsBoard({ stage: "viewed_application", transferred_at: null }), true);
assert.equal(isOnLeadsBoard({}), true);
assert.equal(isOnLeadsBoard(null), true, "an absent data blob must not empty the board");

// Transferred: gone from the board, therefore gone from the drip audience.
// This single assertion is the 306 leads in Signed Application that Adon could
// not see and the engine was still mailing.
assert.equal(
  isOnLeadsBoard({ stage: "signed_application", transferred_at: "2026-07-30T12:00:00Z" }),
  false,
);

// THE LIVE SUBS EXCEPTION is load-bearing, not tidy-up. `uw_sheet` is a
// deliberate Leads-board work queue and legacy rows in it were wrongly stamped
// transferred_at by an old auto-promotion. 85 leads sit there; a naive
// "transferred means gone" rule would empty a column operators work daily AND
// silence the drip that feeds it.
assert.equal(
  isOnLeadsBoard({ stage: LEADS_BOARD_EXEMPT_STAGE, transferred_at: "2026-07-30T12:00:00Z" }),
  true,
  "Live Subs stay on the board even when stamped transferred_at",
);

// A blank string is not a transfer. PostgREST returns an absent key rather than
// null, and treating either as "transferred" would empty the entire board.
assert.equal(isOnLeadsBoard({ stage: "follow_up", transferred_at: "" }), true);
assert.equal(isOnLeadsBoard({ stage: "follow_up", transferred_at: "   " }), true);

// ---------------------------------------------------------------------------
// The predicate and the SQL must express the SAME rule. They are written twice
// by necessity (one runs in the database, one in memory); this pins them
// together so they cannot drift the way the original literals did.
// ---------------------------------------------------------------------------
assert.equal(
  LEADS_BOARD_OR_FILTER,
  `data->>transferred_at.is.null,data->>stage.eq.${LEADS_BOARD_EXEMPT_STAGE}`,
  "the SQL clause must be exactly what the board has always used",
);
{
  const calls: string[] = [];
  const fake = { or(f: string) { calls.push(f); return fake; } };
  const back = applyLeadsBoardFilter(fake);
  assert.equal(calls.length, 1, "exactly one .or() clause");
  assert.equal(calls[0], LEADS_BOARD_OR_FILTER);
  assert.equal(back, fake, "must return the builder so it can be chained");
}

// ---------------------------------------------------------------------------
// Board exit is EDGE-triggered. This is the transition that had no status
// change at all: transferred_at is stamped while stage stays put, so
// detectStatusTransitions reported nothing and the eager drip-cancel never ran.
// ---------------------------------------------------------------------------
{
  const on = { stage: "signed_application" };
  const off = { stage: "signed_application", transferred_at: "2026-08-11T12:00:00Z" };

  const exit = detectBoardExit(on, off);
  assert.equal(exit.length, 1, "crossing off the board must be reported");
  assert.equal(exit[0].field, BOARD_EXIT_FIELD);

  assert.deepEqual(detectBoardExit(on, on), [], "staying on the board is not an event");
  assert.deepEqual(detectBoardExit(off, off), [], "already gone is not an edge");
  // Re-saving a transferred record must not re-cancel runs a later legitimate
  // re-enrolment created.
  assert.deepEqual(detectBoardExit(off, { ...off, notes: "edited" }), []);
  // Coming BACK on the board is not an exit.
  assert.deepEqual(detectBoardExit(off, on), []);
  // A Live Sub stamped transferred_at never leaves, so it never exits.
  assert.deepEqual(
    detectBoardExit({ stage: LEADS_BOARD_EXEMPT_STAGE }, { stage: LEADS_BOARD_EXEMPT_STAGE, transferred_at: "2026-08-11T12:00:00Z" }),
    [],
  );
}

// ---------------------------------------------------------------------------
// A board exit cancels EVERY stage-triggered run, and outranks a stage move
// arriving in the same write. The narrower stage rule would leave the new
// stage's runs alive on a lead that is no longer on the board.
// ---------------------------------------------------------------------------
{
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: { stage: "signed_application", transferred_at: "2026-08-11T12:00:00Z" },
    transitions: [{ field: BOARD_EXIT_FIELD, from: "on_board", to: "off_board" }],
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].newStage, null, "null means cancel every stage-triggered run");
  assert.match(plan[0].reason, /off_board/);
}
{
  // Transfer + stage change in one write: the transfer wins.
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: { stage: "signed_application", transferred_at: "2026-08-11T12:00:00Z" },
    transitions: [
      { field: "stage", from: "viewed_application", to: "signed_application" },
      { field: BOARD_EXIT_FIELD, from: "on_board", to: "off_board" },
    ],
  });
  assert.equal(plan[0].newStage, null, "a transfer must not be downgraded to a stage move");
}
{
  // An ordinary stage move is untouched by any of this.
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: { stage: "signed_application" },
    transitions: [{ field: "stage", from: "viewed_application", to: "signed_application" }],
  });
  assert.equal(plan[0].newStage, "signed_application");
}

// ---------------------------------------------------------------------------
// ONE COPY OF THE RULE. The literal appearing anywhere outside
// board-visibility.ts is the exact defect this file exists to prevent: the
// board and the drip engine holding separate copies and drifting apart.
// ---------------------------------------------------------------------------
{
  const read = (p: string) => readFileSync(p, "utf8");
  const LITERAL = "data->>transferred_at.is.null";
  for (const path of ["lib/manifest/data.ts", "lib/drips/enroller.ts", "lib/drips/executor.ts"]) {
    assert.ok(
      !read(path).includes(LITERAL),
      `${path} must import the rule from lib/leads/board-visibility.ts, not restate it`,
    );
  }
  assert.ok(
    read("lib/leads/board-visibility.ts").includes(LITERAL),
    "and board-visibility.ts must be where it lives",
  );
}

console.log("drip-board-parity.test.ts — the drip audience is the board's audience ✓");
