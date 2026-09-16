import assert from "node:assert";

import { OPTION_COUNT, buildOptions, rng, shuffle } from "@/lib/training/drills";
import { SECTIONS, sectionBySlug } from "@/lib/training/curriculum";
import { ITEMS, groupPeers, itemsForSection } from "@/lib/training/items";
import { buildTrainingDrill, buildTrainingSession, underpoweredGroups } from "@/lib/training/session";
import { SECTION_SLUGS, isSectionSlug } from "@/lib/training/types";
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
  assert.ok(item.prompt.trim().length > 0, `${item.id} has no prompt`);
  assert.ok(item.answer.trim().length > 0, `${item.id} has no answer`);
  assert.ok(item.because.trim().length > 0, `${item.id} explains nothing, so being wrong teaches nothing`);
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
  for (const [field, text] of [["prompt", item.prompt], ["answer", item.answer], ["because", item.because]] as const) {
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

// Every group needs at least two members or its question has one option, which
// is not a question. Surfaced here rather than left for a rep to meet.
assert.deepEqual(
  underpoweredGroups(2),
  [],
  "a drill group with fewer than two items produces a one-option question",
);

for (const item of ITEMS) {
  const peers = groupPeers(item);
  assert.ok(peers.some((p) => p.id === item.id), `${item.id} is not in its own group`);
  assert.ok(
    peers.every((p) => p.section === item.section),
    `${item.id}'s group spans sections, so its decoys come from a different subject`,
  );
}

console.log("training-drills: every group can produce a real question OK");

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
console.log("training-drills: ALL OK");
