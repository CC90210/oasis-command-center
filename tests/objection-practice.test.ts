import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  DRILL_KINDS,
  OPTION_COUNT,
  SELF_CHECKS,
  buildDrill,
  buildSession,
  checkSpokenAnswer,
  rng,
  shuffle,
  type DrillKind,
  type PracticeObjection,
} from "@/lib/web-leads/objections/practice";
import { OBJECTION_POSTURES } from "@/lib/web-leads/objections/types";

// ---------------------------------------------------------------------------
// The practice trainer.
//
// The failure that matters here is not a crash, it is a drill that teaches the
// wrong thing: two options that are both right, a decoy that is actually the
// answer, or an objection that never comes up. A rep cannot tell any of those
// from a working question, which is why they are asserted rather than eyeballed.
//
// WHAT THIS DOES NOT COVER, stated rather than implied:
//   - Whether the drills make anyone better at selling. No test can say that.
//   - The React component. These cover the pure logic it renders.
// ---------------------------------------------------------------------------

const objection = (n: number): PracticeObjection => ({
  slug: `slug-${n}`,
  says: `They say number ${n}.`,
  meaning: `Meaning number ${n}, which is different from all the others.`,
  prevent: `Prevent number ${n}, also distinct.`,
  family: n % 2 === 0 ? "brush_off" : "no_need",
  posture: OBJECTION_POSTURES[n % OBJECTION_POSTURES.length],
  answer: `Answer number ${n}, said out loud.`,
});

const POOL: PracticeObjection[] = Array.from({ length: 8 }, (_, i) => objection(i + 1));

// --- determinism ----------------------------------------------------------

assert.deepEqual(
  Array.from({ length: 5 }, rng(42)),
  Array.from({ length: 5 }, rng(42)),
  "the same seed must produce the same sequence, or a reload silently reshuffles a rep's drill",
);
assert.notDeepEqual(
  Array.from({ length: 5 }, rng(1)),
  Array.from({ length: 5 }, rng(2)),
  "different seeds must differ, or 'go again' returns the identical round",
);

const items = [1, 2, 3, 4, 5, 6, 7, 8];
assert.deepEqual(shuffle(items, rng(7)), shuffle(items, rng(7)), "shuffle is deterministic under a seed");
assert.deepEqual(
  shuffle(items, rng(7)).slice().sort((a, b) => a - b),
  items,
  "shuffle keeps every item exactly once, losing none and inventing none",
);

// --- exactly one right answer, every time ---------------------------------

for (const kind of DRILL_KINDS) {
  if (kind === "your_words") continue;
  for (let seed = 1; seed <= 25; seed++) {
    for (const target of POOL) {
      const drill = buildDrill(target, POOL, kind, rng(seed));
      assert.ok(drill.options, `${kind} must offer options`);
      const correct = drill.options!.filter((o) => o.correct);
      assert.equal(
        correct.length,
        1,
        `${kind}/${target.slug}/seed ${seed} had ${correct.length} correct options, not 1`,
      );
      const texts = drill.options!.map((o) => o.text.trim());
      assert.equal(
        new Set(texts).size,
        texts.length,
        `${kind}/${target.slug}/seed ${seed} repeated an option, which makes two answers right`,
      );
    }
  }
}

// The right answer is the TARGET's own text, not merely some correct-looking
// option. A drill that marked another objection's meaning correct would be
// consistent and wrong.
for (let seed = 1; seed <= 10; seed++) {
  const target = POOL[seed % POOL.length];
  const meaningDrill = buildDrill(target, POOL, "meaning", rng(seed));
  assert.equal(
    meaningDrill.options!.find((o) => o.correct)!.text,
    target.meaning,
    "the correct option must be this objection's own meaning",
  );
  const preventDrill = buildDrill(target, POOL, "prevent", rng(seed));
  assert.equal(
    preventDrill.options!.find((o) => o.correct)!.text,
    target.prevent,
    "the correct option must be this objection's own prevention line",
  );
}

// Option count, and the small-pool case: fewer objections than options means a
// shorter question, never a padded or duplicated one.
const bigDrill = buildDrill(POOL[0], POOL, "meaning", rng(3));
assert.equal(bigDrill.options!.length, OPTION_COUNT, "a full pool gives a full set of options");
const tiny = POOL.slice(0, 2);
const tinyDrill = buildDrill(tiny[0], tiny, "meaning", rng(3));
assert.equal(tinyDrill.options!.length, 2, "a two-objection pool gives two options rather than padding");
assert.equal(tinyDrill.options!.filter((o) => o.correct).length, 1, "still exactly one correct");

// --- a shared line must not produce two right answers ---------------------
//
// Two objections occasionally carry a near-identical prevention line. Deduping
// by slug rather than by TEXT would offer the same sentence twice, one marked
// correct and one not, and the rep would be marked wrong for picking the
// identical words.
const twins: PracticeObjection[] = [
  { ...objection(1), slug: "twin-a", prevent: "Ask the diagnostic question before you pitch." },
  { ...objection(2), slug: "twin-b", prevent: "Ask the diagnostic question before you pitch." },
  objection(3),
  objection(4),
  objection(5),
];
for (let seed = 1; seed <= 25; seed++) {
  const drill = buildDrill(twins[0], twins, "prevent", rng(seed));
  const texts = drill.options!.map((o) => o.text.trim());
  assert.equal(new Set(texts).size, texts.length, `seed ${seed}: a duplicated prevention line reached the options`);
  assert.equal(drill.options!.filter((o) => o.correct).length, 1, `seed ${seed}: not exactly one correct`);
}

// --- the move drill -------------------------------------------------------

const moveDrill = buildDrill(POOL[2], POOL, "move", rng(9));
assert.equal(moveDrill.options!.length, OBJECTION_POSTURES.length, "all four moves are offered");
assert.equal(moveDrill.options!.filter((o) => o.correct).length, 1, "exactly one move is right");
assert.equal(moveDrill.options!.find((o) => o.correct)!.id, POOL[2].posture, "and it is this objection's move");

// --- your_words -----------------------------------------------------------

const own = buildDrill(POOL[0], POOL, "your_words", rng(1));
assert.equal(own.options, null, "there is nothing to choose between when you write it yourself");
assert.equal(own.reveal.length, 3, "the reveal carries meaning, prevention and a worked example");
assert.ok(
  own.reveal.some((r) => r.text === POOL[0].answer),
  "the approved answer is revealed, but only as part of the reveal",
);

console.log("objection-practice: drills always have exactly one right answer OK");

// --- a session covers everything -----------------------------------------

const kinds: DrillKind[] = ["meaning", "prevent"];
const session = buildSession(POOL, kinds, 5);
assert.equal(session.length, POOL.length * kinds.length, "every objection appears once per drill kind");
for (const kind of kinds) {
  const slugs = session.filter((d) => d.kind === kind).map((d) => d.slug).sort();
  assert.deepEqual(
    slugs,
    POOL.map((o) => o.slug).sort(),
    `${kind} must cover every objection: the ones a rep avoids are the ones they need`,
  );
}
assert.deepEqual(
  buildSession(POOL, kinds, 5).map((d) => `${d.kind}:${d.slug}`),
  session.map((d) => `${d.kind}:${d.slug}`),
  "a session is reproducible under its seed",
);
assert.deepEqual(buildSession([], kinds, 5), [], "an empty catalog yields no drills rather than throwing");

console.log("objection-practice: a session covers every objection, reproducibly OK");

// --- checking what a rep typed -------------------------------------------

const clean = checkSpokenAnswer(
  "That is fair, and most people say it. Can I ask what would have to change for it to be worth doing?",
);
assert.deepEqual(clean.blocking, [], "an ordinary spoken answer is not blocked");
assert.ok(clean.wordCount > 8);

assert.ok(
  checkSpokenAnswer("It costs about $400 to sort out.").blocking.some((b) => b.includes("money figure")),
  "a price a rep has not scoped is blocking, not a suggestion",
);
assert.ok(
  checkSpokenAnswer("That is fair — and here is the thing.").blocking.some((b) => b.includes("em or en dash")),
  "a dash is blocking",
);
assert.ok(checkSpokenAnswer("").blocking.length > 0, "an empty answer is blocking");

// Notes are observations, never a verdict on quality.
assert.ok(
  checkSpokenAnswer("Yeah fair enough.").notes.some((n) => n.includes("very short")),
  "a two-word answer is noted",
);
assert.ok(
  checkSpokenAnswer(("word ".repeat(120)).trim()).notes.some((n) => n.includes("paraphrase")),
  "an answer too long to say is noted",
);
assert.deepEqual(
  checkSpokenAnswer("Yeah fair enough.").blocking,
  [],
  "being short is a NOTE, not a block: nothing here may pretend to judge whether an answer is good",
);

assert.ok(SELF_CHECKS.length >= 4, "the self-check must cover the judgements a machine cannot make");
assert.ok(
  SELF_CHECKS.some((c) => c.ask.toLowerCase().includes("concede")),
  "conceding first is the habit most worth asking about",
);

console.log("objection-practice: typed answers are checked mechanically and never scored OK");
// --- both ways into a round must reset it --------------------------------
//
// Review finding on this branch. "Change what I drill" only hid the end
// screen, so the Start button resumed with the FINISHED index and the previous
// score: picking the same or a shorter set dropped the rep straight back on
// "Done", and a longer set began partway through with stale numbers. Two
// buttons that both begin a round cannot each own a private idea of what
// beginning means, so both now go through one reset.
const trainerSource = fs.readFileSync(
  path.join(process.cwd(), "components/objections/PracticeTrainer.tsx"),
  "utf8",
);
assert.ok(
  /const begin = useCallback\(/.test(trainerSource),
  "there must be ONE function that starts a round",
);
assert.ok(
  !/onClick=\{\(\) => setStarted\(true\)\}/.test(trainerSource),
  "no button may start a round by flipping `started` alone, which leaves the finished index in place",
);
assert.equal(
  (trainerSource.match(/begin\((?:true|false)\)/g) || []).length,
  2,
  "both the Start button and Go again must route through begin()",
);

console.log("objection-practice: both entry points reset the round OK");

console.log("objection-practice: ALL OK");
