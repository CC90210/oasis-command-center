import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { OPTION_COUNT, buildOptions, rng, shuffle } from "@/lib/training/drills";
import { SECTIONS, sectionBySlug } from "@/lib/training/curriculum";
import { ITEMS, groupPeers, itemsForSection, itemsForUnit, unitsForSection } from "@/lib/training/items";
import {
  DISTRACTOR_MARK,
  buildTrainingDrill,
  buildTrainingSession,
  gradeAnswer,
  underpoweredItems,
} from "@/lib/training/session";
import { SECTION_SLUGS, isSectionSlug } from "@/lib/training/types";
import { authoringViolations } from "@/lib/training/authoring-rules";
import { copyViolations } from "@/lib/web-leads/objections/copy-rules";

// ---------------------------------------------------------------------------
// The Training curriculum and its drills.
//
// The failure that matters here is not a crash, it is a drill that teaches the
// wrong thing: two right answers, a decoy that is also correct, an item nobody
// ever sees, or a price presented as a fact. A rep cannot tell any of those
// from a working question, which is why they are asserted rather than read.
//
// WHAT THIS DOES NOT COVER, stated rather than implied:
//   - Whether the curriculum is any GOOD, or whether the drills make anyone
//     better at selling. No test can say that.
//   - The database. `lib/training/progress.ts` needs a live libSQL connection.
//   - The React components. These cover the pure logic they render.
// ---------------------------------------------------------------------------

// --- the shared drill engine ----------------------------------------------

assert.deepEqual(Array.from({ length: 5 }, rng(11)), Array.from({ length: 5 }, rng(11)),
  "the same seed must give the same sequence, or a reload reshuffles a rep's drill");
assert.notDeepEqual(Array.from({ length: 5 }, rng(1)), Array.from({ length: 5 }, rng(2)),
  "different seeds must differ, or 'go again' returns the identical round");

const nums = [1, 2, 3, 4, 5, 6];
assert.deepEqual(shuffle(nums, rng(4)).slice().sort((a, b) => a - b), nums,
  "shuffle keeps every item exactly once, losing none and inventing none");

// buildOptions is the one invariant worth the file it lives in.
{
  const pool = [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Bravo" },
    { id: "c", text: "Charlie" },
    { id: "d", text: "Delta" },
    { id: "e", text: "Echo" },
  ];
  for (let seed = 1; seed <= 40; seed++) {
    const opts = buildOptions({ id: "a", text: "Alpha" }, pool, rng(seed));
    assert.equal(opts.filter((o) => o.correct).length, 1, `seed ${seed}: not exactly one correct`);
    assert.equal(opts.find((o) => o.correct)!.text, "Alpha", `seed ${seed}: the wrong option is marked correct`);
    const texts = opts.map((o) => o.text);
    assert.equal(new Set(texts).size, texts.length, `seed ${seed}: a repeated option`);
    assert.ok(opts.length <= OPTION_COUNT, `seed ${seed}: too many options`);
  }

  // A shared sentence must not appear twice, once right and once wrong.
  const twins = [
    { id: "a", text: "Ask before you pitch" },
    { id: "b", text: "Ask before you pitch" },
    { id: "c", text: "Something else entirely" },
  ];
  for (let seed = 1; seed <= 25; seed++) {
    const opts = buildOptions({ id: "a", text: "Ask before you pitch" }, twins, rng(seed));
    const texts = opts.map((o) => o.text.trim());
    assert.equal(new Set(texts).size, texts.length, `seed ${seed}: a duplicated option reached the drill`);
    assert.equal(opts.filter((o) => o.correct).length, 1, `seed ${seed}: not exactly one correct`);
  }

  // Fewer candidates yields a SHORTER question, never a padded one.
  const short = buildOptions({ id: "a", text: "Alpha" }, [{ id: "b", text: "Bravo" }], rng(3));
  assert.equal(short.length, 2, "a two-candidate pool gives two options rather than padding");
  assert.equal(short.filter((o) => o.correct).length, 1, "still exactly one correct");
}

console.log("training-drills: the shared engine always yields exactly one right answer OK");

// --- the curriculum --------------------------------------------------------

assert.equal(SECTIONS.length, SECTION_SLUGS.length, "every declared slug must have a section");
for (const slug of SECTION_SLUGS) {
  const section = sectionBySlug(slug);
  assert.ok(section, `${slug} has no section`);
  assert.ok(section!.title.trim().length > 0, `${slug} has no title`);
  assert.ok(section!.promise.trim().length > 0, `${slug} promises nothing`);
  assert.ok(section!.source.trim().length > 0, `${slug} names no source`);
  assert.ok(section!.lessons.length > 0, `${slug} has no lessons`);
  for (const lesson of section!.lessons) {
    assert.ok(lesson.body.length > 0, `${slug}/${lesson.id} has an empty body`);
    for (const para of lesson.body) {
      assert.ok(para.trim().length > 0, `${slug}/${lesson.id} has a blank paragraph`);
    }
  }
}
assert.equal(new Set(SECTIONS.map((s) => s.slug)).size, SECTIONS.length, "duplicate section slug");
assert.ok(isSectionSlug("opening") && !isSectionSlug("nope"), "isSectionSlug must actually narrow");

// Every item belongs to a real section, and every id is unique.
const ids = ITEMS.map((i) => i.id);
assert.equal(new Set(ids).size, ids.length, "duplicate drill item id");
for (const item of ITEMS) {
  assert.ok(isSectionSlug(item.section), `${item.id} sits in an unknown section`);
  assert.ok(item.stem.trim().length > 0, `${item.id} has no stem`);
  assert.ok(item.answer.trim().length > 0, `${item.id} has no answer`);
  assert.ok(item.whyRight.trim().length > 0, `${item.id} explains nothing, so being wrong teaches nothing`);
  assert.ok(item.unit.trim().length > 0, `${item.id} belongs to no unit`);
  assert.ok(item.source.trim().length > 0, `${item.id} names no source`);
  // An id containing the distractor separator would make a wrong option's id
  // parse back to a different item, which grades a wrong answer as right.
  assert.ok(
    !item.id.includes(DISTRACTOR_MARK),
    `${item.id} contains the distractor marker, which collides with option ids`,
  );
}

// ---------------------------------------------------------------------------
// EVERY ITEM PASSES THE AUTHORING LINT.
//
// This is what makes "the questions are vague" a build failure rather than an
// opinion. The lint caught 8 of the 32 items in this file while they were being
// written, including three clang clues and a length giveaway that nobody would
// have found by reading.
// ---------------------------------------------------------------------------
for (const item of ITEMS) {
  const violations = authoringViolations(item);
  assert.deepEqual(violations, [], `${item.id} breaks an authoring rule: ${violations.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// 🚨 NO DRILL ANSWER STATES A PRICE.
//
// The three source documents give three incompatible pricing rules, and one of
// them says in its own words that no approved price exists
// (docs/training/CONTENT_CONFLICTS.md). A drill whose right answer is an
// unapproved number would teach fifteen reps to say it out loud, which is the
// objection engine's failure arriving through a different door. The same copy
// rules that bind every spoken objection line bind these.
// ---------------------------------------------------------------------------
for (const item of ITEMS) {
  const fields: (readonly [string, string])[] = [
    ["stem", item.stem],
    ["answer", item.answer],
    ["whyRight", item.whyRight],
    // Distractors are rep-facing text too. They did not exist when this check
    // was written, and an unapproved number in a WRONG answer is read by
    // exactly the same eyes as one in a right answer.
    ...item.distractors.flatMap((d, i) => [
      [`distractor${i}.text`, d.text] as const,
      [`distractor${i}.whyWrong`, d.whyWrong] as const,
      [`distractor${i}.realError`, d.realError] as const,
    ]),
  ];
  for (const [field, text] of fields) {
    const violations = copyViolations(text, `${item.id}.${field}`, 600);
    assert.deepEqual(
      violations,
      [],
      `${item.id}.${field} breaks a copy rule: ${violations.join(" ")}`,
    );
  }
}
for (const section of SECTIONS) {
  for (const lesson of section.lessons) {
    for (const line of lesson.lines ?? []) {
      const violations = copyViolations(line, `${section.slug}/${lesson.id}`, 600);
      assert.deepEqual(violations, [], `a line a rep says aloud breaks a copy rule: ${violations.join(" ")}`);
    }
  }
}

console.log("training-drills: the curriculum is complete and states no price OK");

// --- decoys must be hard ---------------------------------------------------

// Every item needs at least two authored wrong answers, or its question is a
// coin flip. This used to count GROUP members, because a group supplied the
// decoys; since 2026-09-17 distractors are authored per item, so the thing that
// can go wrong moved and the assertion moved with it.
assert.deepEqual(
  underpoweredItems(2),
  [],
  "an item with fewer than two authored distractors is a coin flip, not a question",
);

// `group` survives for a different job: items in one group are CONFUSABLE with
// each other, which is what the scheduler interleaves on. A group spanning two
// sections would interleave unrelated subjects.
for (const item of ITEMS) {
  const peers = groupPeers(item);
  assert.ok(peers.some((p) => p.id === item.id), `${item.id} is not in its own group`);
  assert.ok(
    peers.every((p) => p.section === item.section),
    `${item.id} has a group spanning sections, so interleaving would mix subjects`,
  );
}

// Every unit sits in exactly one section, or "finish this unit" spans two
// places in the navigation and can be completed in neither.
{
  const unitSection = new Map<string, string>();
  for (const item of ITEMS) {
    const seen = unitSection.get(item.unit);
    assert.ok(
      seen === undefined || seen === item.section,
      `unit ${item.unit} appears in two sections at once`,
    );
    unitSection.set(item.unit, item.section);
  }
  for (const section of SECTIONS) {
    for (const unit of unitsForSection(section.slug)) {
      assert.ok(itemsForUnit(unit).length > 0, `${unit} is listed but has no items`);
    }
  }
}

console.log("training-drills: every item can produce a real question OK");

// --- the chosen wrong answer explains ITSELF -------------------------------
//
// Asserted rather than trusted because the failure is invisible: a drill that
// renders its options but loses the per-option explanation looks completely
// normal on screen, and multiple choice WITHOUT that feedback installs the
// distractors as false knowledge rather than correcting them (Roediger & Marsh
// 2005). That is worse than not drilling at all.
for (const item of ITEMS) {
  const drill = buildTrainingDrill(item, rng(3));
  for (const option of drill.options) {
    if (option.correct) {
      assert.equal(option.whyWrong, undefined, `${item.id}: the right answer must carry no whyWrong`);
      continue;
    }
    assert.ok(option.whyWrong?.trim(), `${item.id}: a wrong option reached the drill unexplained`);
    assert.ok(option.realError?.trim(), `${item.id}: a wrong option names no mistake`);
    // And it must be THIS option's explanation, not another option's.
    const authored = item.distractors.find((d) => d.text === option.text);
    assert.equal(
      option.whyWrong,
      authored?.whyWrong,
      `${item.id}: an option shows another option's explanation, which teaches the wrong lesson`,
    );
  }
}

console.log("training-drills: each wrong option carries its own explanation OK");

// --- drills and sessions ---------------------------------------------------

for (let seed = 1; seed <= 30; seed++) {
  for (const item of ITEMS) {
    const drill = buildTrainingDrill(item, rng(seed));
    const correct = drill.options.filter((o) => o.correct);
    assert.equal(correct.length, 1, `${item.id}/seed ${seed}: ${correct.length} correct options, not 1`);
    assert.equal(correct[0].text, item.answer, `${item.id}/seed ${seed}: the correct option is not this item's answer`);
    const texts = drill.options.map((o) => o.text.trim());
    assert.equal(new Set(texts).size, texts.length, `${item.id}/seed ${seed}: a repeated option`);
    assert.ok(drill.options.length >= 2, `${item.id}/seed ${seed}: fewer than two options is not a question`);
  }
}

// A session covers EVERY item in scope. The items a rep would skip are the ones
// they are worst at, so a sampling drill lets them never meet those.
for (const section of SECTIONS) {
  const expected = itemsForSection(section.slug).map((i) => i.id).sort();
  if (expected.length === 0) continue;
  const got = buildTrainingSession(section.slug, 7).map((d) => d.itemId).sort();
  assert.deepEqual(got, expected, `${section.slug} does not cover every one of its items`);
}
const all = buildTrainingSession("all", 9);
assert.equal(all.length, ITEMS.length, "an 'all' session must cover every item");
assert.deepEqual(
  buildTrainingSession("all", 9).map((d) => d.itemId),
  all.map((d) => d.itemId),
  "a session must be reproducible under its seed",
);
assert.notDeepEqual(
  buildTrainingSession("all", 10).map((d) => d.itemId),
  all.map((d) => d.itemId),
  "a different seed must reorder, or 'go again' is the same round",
);

console.log("training-drills: sessions cover every item, reproducibly OK");
// --- correctness is derived from the curriculum, not read off the body -----
//
// Review finding on this branch, and then a SECOND finding on the fix. The
// endpoint first took a `correct: boolean` from the request body, so any
// client bug could record a wrong answer as right. That is fixed and these
// assertions pin it.
//
// What is NOT fixed, asserted nowhere because it is not true: this does not
// stop a determined rep faking their own record. Both ids come from the client
// and the browser knows all of them. Nothing grading a CLIENT-BUILT drill can
// prevent that; it needs the server to issue each question. Recorded in
// `gradeAnswer` and in ACTIVE_WORK rather than papered over here, because a
// test named "the client cannot forge this" would be a lie in a place people
// trust.

for (const item of ITEMS) {
  const right = gradeAnswer(item.id, item.section, item.id);
  assert.ok(right.ok && right.correct, `${item.id}: choosing the item's own id must grade correct`);

  // A distractor id is the item id plus a marker. Grading it wrong also pins
  // that the marker cannot be mistaken for the item id itself.
  const distractorId = `${item.id}${DISTRACTOR_MARK}0`;
  const wrong = gradeAnswer(item.id, item.section, distractorId);
  assert.ok(wrong.ok && !wrong.correct, `${item.id}: choosing a distractor must grade wrong`);
}

// An item that does not exist cannot be graded, so it is refused rather than
// recorded. A write that cannot be checked is a write nobody can trust.
assert.deepEqual(
  gradeAnswer("no-such-item", "opening", "no-such-item"),
  { ok: false, reason: "unknown_item" },
  "an unknown item must be refused, not silently recorded as correct",
);

// The section is checked too, so a caller cannot file a right answer under a
// section it does not belong to and inflate that section's total.
{
  const item = ITEMS[0];
  const otherSection = SECTION_SLUGS.find((s) => s !== item.section)!;
  assert.deepEqual(
    gradeAnswer(item.id, otherSection, item.id),
    { ok: false, reason: "section_mismatch" },
    "an item filed under the wrong section must be refused",
  );
}

// The route must not read a correctness flag off the body at all.
const routeSource = fs.readFileSync(
  path.join(process.cwd(), "app/api/training/progress/route.ts"),
  "utf8",
);
assert.ok(
  /gradeAnswer\(/.test(routeSource),
  "the progress route must derive correctness from the curriculum",
);
assert.ok(
  !/payload\.correct/.test(routeSource),
  "the progress route must never read a correctness flag from the request body",
);

console.log("training-drills: correctness comes from the curriculum, not the request body OK");

console.log("training-drills: ALL OK");
