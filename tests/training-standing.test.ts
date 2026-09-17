import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { ITEMS } from "@/lib/training/items";
import { finishedCount, sectionStandings } from "@/lib/training/standing";

// ---------------------------------------------------------------------------
// Stored progress, read against the curriculum that exists TODAY.
//
// The defect this file exists for was found by review on commit 2bcf0f8f. The
// item bank was rewritten, every id changed, and the hub counted stored rows by
// section while sizing the denominator from the live curriculum. A rep who had
// practised the old items would have been shown "7 of 4 known", and a stored
// completion would still have lit the Finished badge on a section whose
// questions they had never once seen.
//
// It is the shape of bug that reads as completely normal on screen, which is
// why the numbers are asserted rather than eyeballed.
// ---------------------------------------------------------------------------

const CURRENT = [
  { id: "a1", section: "opening" },
  { id: "a2", section: "opening" },
  { id: "b1", section: "diagnosis" },
];

// --- the exact regression --------------------------------------------------

{
  // Seven rows of history, all for items that no longer exist.
  const progress = Array.from({ length: 7 }, (_, i) => ({
    itemId: `old-${i}`,
    sectionSlug: "opening",
    rightCount: 3,
  }));
  const standings = sectionStandings({
    items: CURRENT,
    progress,
    completedSlugs: new Set(["opening"]),
  });

  const opening = standings.get("opening")!;
  assert.equal(opening.known, 0, "history for removed items must count for nothing");
  assert.equal(opening.total, 2, "the denominator is what the section holds today");
  assert.equal(
    opening.finished,
    false,
    "a completion earned on the old curriculum must not mark the new one finished",
  );
  assert.equal(finishedCount(standings), 0, "and it must not count toward the header total");
}

// --- the numerator can never exceed the denominator ------------------------

{
  // A duplicated row for the same item, which a retry could produce.
  const standings = sectionStandings({
    items: CURRENT,
    progress: [
      { itemId: "a1", sectionSlug: "opening", rightCount: 1 },
      { itemId: "a1", sectionSlug: "opening", rightCount: 4 },
    ],
    completedSlugs: new Set(),
  });
  const opening = standings.get("opening")!;
  assert.equal(opening.known, 1, "the same item twice is one item known, not two");
  assert.ok(opening.known <= opening.total, "known must never exceed the section size");
}

// --- what a real, current completion looks like ---------------------------

{
  const progress = [
    { itemId: "a1", sectionSlug: "opening", rightCount: 1 },
    { itemId: "a2", sectionSlug: "opening", rightCount: 2 },
    { itemId: "b1", sectionSlug: "diagnosis", rightCount: 1 },
  ];
  const standings = sectionStandings({
    items: CURRENT,
    progress,
    completedSlugs: new Set(["opening"]),
  });
  assert.deepEqual(
    standings.get("opening"),
    { known: 2, total: 2, finished: true },
    "covering every current item with a completion on file is finished",
  );
  assert.equal(
    standings.get("diagnosis")!.finished,
    false,
    "covering the items without a completion on file is not finished",
  );
  assert.equal(finishedCount(standings), 1);
}

// --- a completion without coverage is not enough --------------------------

{
  const standings = sectionStandings({
    items: CURRENT,
    progress: [{ itemId: "a1", sectionSlug: "opening", rightCount: 1 }],
    completedSlugs: new Set(["opening"]),
  });
  assert.equal(
    standings.get("opening")!.finished,
    false,
    "a stored completion covering half the section must not read as finished",
  );
}

// --- a wrong-only row is history, not knowledge ---------------------------

{
  const standings = sectionStandings({
    items: CURRENT,
    progress: [{ itemId: "a1", sectionSlug: "opening", rightCount: 0 }],
    completedSlugs: new Set(),
  });
  assert.equal(standings.get("opening")!.known, 0, "a row with no right answers is not knowledge");
}

// --- every real section is represented ------------------------------------

{
  const standings = sectionStandings({ items: ITEMS, progress: [], completedSlugs: new Set() });
  for (const item of ITEMS) {
    assert.ok(standings.has(item.section), `${item.section} is missing from the standings`);
  }
  for (const [, s] of standings) {
    assert.ok(s.total > 0, "a listed section must hold items");
    assert.equal(s.known, 0, "a rep with no history knows nothing yet");
    assert.equal(s.finished, false, "and has finished nothing");
  }
}

// --- the page must actually use it ----------------------------------------
//
// A pure function nothing calls is documentation. This pins that the hub reads
// its numbers from here, and specifically that the old per-row tally which
// produced "7 of 4" has not come back.

const hub = fs.readFileSync(path.join(process.cwd(), "app/training/page.tsx"), "utf8");
assert.ok(
  /sectionStandings\(/.test(hub),
  "the training hub must derive its counts from sectionStandings",
);
assert.ok(
  !/rightBySection/.test(hub),
  "the per-row tally that counted history for removed items must not return",
);
assert.ok(
  !/completedSlugs\.has\(section\.slug\)/.test(hub),
  "the Finished badge must not come straight from a stored completion again",
);

console.log("training-standing: stored history is read against today's curriculum OK");
