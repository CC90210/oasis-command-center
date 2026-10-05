/**
 * The practice trainer's brain: building drills out of the live objection
 * catalog, and checking what a rep typed.
 *
 * WHY DRILLS RATHER THAN A SCRIPT LIBRARY. The catalog already shows a rep the
 * approved answer on the battle card, mid-call, when they need it. Reading it
 * again in a training tab teaches nothing, and worse, it trains recital: a rep
 * reading our sentence aloud sounds like somebody reading, and the owner hears
 * it immediately. So every drill here makes the rep produce something, and the
 * one drill that shows them our wording shows it only AFTER they have written
 * their own.
 *
 * THE ORDER OF THE DRILLS IS THE ARGUMENT. `meaning` comes before `prevent`,
 * and `prevent` comes before answering, because our own sales review found
 * reps collect objections they created by pitching too early. A trainer that
 * only drilled answers would teach the symptom and reinforce the cause.
 *
 * PURE AND SEEDED. Everything here is a pure function of the catalog and a
 * numeric seed. No I/O, no Math.random, no Date. That is what lets the tests
 * assert that a round always has exactly one right answer and that no decoy
 * is accidentally also correct, which is the failure that would quietly teach
 * a rep the wrong thing.
 */

import { copyViolations } from "@/lib/web-leads/objections/copy-rules";
import {
  OPTION_COUNT,
  buildOptions,
  rng,
  shuffle,
  type DrillOption,
} from "@/lib/training/drills";
import {
  OBJECTION_POSTURES,
  POSTURE_LABEL,
  type ObjectionPosture,
} from "@/lib/web-leads/objections/types";

/** What a drill needs from one objection. A narrowed shape rather than
 *  CatalogObjection, so a test can build a fixture without inventing ids,
 *  premises and answer rows that no drill reads. */
export type PracticeObjection = {
  slug: string;
  says: string;
  meaning: string;
  prevent: string;
  family: string;
  posture: ObjectionPosture;
  answer: string;
};

export const DRILL_KINDS = ["meaning", "prevent", "move", "your_words"] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export const DRILL_TITLE: Record<DrillKind, string> = {
  meaning: "What are they really saying?",
  prevent: "How do you stop it coming up?",
  move: "Which move is this?",
  your_words: "Say it your way",
};

export const DRILL_TEACHES: Record<DrillKind, string> = {
  meaning: "Diagnosis. Everything else follows from reading this right.",
  prevent: "The half that costs nothing. An objection you prevented is free.",
  move: "Naming the move you are making, so you make one on purpose.",
  your_words: "Producing it yourself, which is the only part that survives a real call.",
};


export type Drill = {
  kind: DrillKind;
  slug: string;
  says: string;
  /** Null for `your_words`, which has nothing to choose between. */
  options: DrillOption[] | null;
  /** Shown only after the rep has answered. */
  reveal: { label: string; text: string }[];
};


/**
 * One drill for one objection.
 *
 * Decoys come from OTHER objections' real text, never invented, because a
 * plausible-but-wrong option has to be something a rep could genuinely
 * confuse with the right one. Made-up decoys are easy to eliminate on style
 * alone and the drill stops testing anything.
 *
 * Deduplicated by TEXT, not by slug: two objections occasionally share a
 * prevention line almost word for word, and offering the same sentence twice
 * makes a question with two right answers.
 */
export function buildDrill(
  target: PracticeObjection,
  pool: readonly PracticeObjection[],
  kind: DrillKind,
  next: () => number,
): Drill {
  const says = target.says;

  if (kind === "your_words") {
    return {
      kind,
      slug: target.slug,
      says,
      options: null,
      reveal: [
        { label: "What it really means", text: target.meaning },
        { label: "How to stop it coming up", text: target.prevent },
        { label: "One way it has been said well", text: target.answer },
      ],
    };
  }

  if (kind === "move") {
    const options = shuffle(OBJECTION_POSTURES, next).map((p) => ({
      id: p,
      text: POSTURE_LABEL[p],
      correct: p === target.posture,
    }));
    return {
      kind,
      slug: target.slug,
      says,
      options,
      reveal: [
        { label: "The move", text: POSTURE_LABEL[target.posture] },
        { label: "The answer that makes it", text: target.answer },
      ],
    };
  }

  const field = kind === "meaning" ? "meaning" : "prevent";
  const correctText = target[field];
  // Shared with the Training drills. `buildOptions` owns the guarantee that
  // exactly one option is correct, that decoys come from real content rather
  // than being invented, and that two items carrying almost the same sentence
  // cannot both appear.
  const options = buildOptions(
    { id: target.slug, text: correctText },
    pool.map((p) => ({ id: p.slug, text: p[field] })),
    next,
    OPTION_COUNT,
  );

  return {
    kind,
    slug: target.slug,
    says,
    options,
    reveal: [
      { label: kind === "meaning" ? "What it really means" : "How to stop it coming up", text: correctText },
      { label: "One way it has been said well", text: target.answer },
    ],
  };
}

/**
 * A full session: every objection, in each drill kind asked for, shuffled.
 *
 * Every objection appears for every selected kind rather than a random
 * sample, because the point is coverage. A rep who never sees the four
 * objections they are worst at has not practised.
 */
export function buildSession(
  pool: readonly PracticeObjection[],
  kinds: readonly DrillKind[],
  seed: number,
): Drill[] {
  const next = rng(seed);
  const drills: Drill[] = [];
  for (const kind of kinds) {
    for (const target of pool) drills.push(buildDrill(target, pool, kind, next));
  }
  return shuffle(drills, next);
}

export type SpokenCheck = {
  /** Rules a machine can actually judge. Failing one is a fact, not an opinion. */
  blocking: string[];
  /** Things worth noticing that are NOT a verdict on quality. */
  notes: string[];
  wordCount: number;
};

/** Below this a rep has not answered, they have grunted. */
const MIN_WORDS = 8;
/** Above this they will paraphrase on a real call instead of saying it. */
const LONG_WORDS = 90;

/**
 * Checks what a rep typed, and is careful about what it does NOT claim.
 *
 * `blocking` is the copy rules, which are mechanical: a price, a dash, an
 * empty box. Those are facts and the trainer states them as such.
 *
 * `notes` are observations, not marks. Nothing here scores whether an answer
 * is any GOOD, because that judgement needs a human ear and a pretend score
 * would be worse than none: a rep who scores nine out of ten on a sentence
 * that would die on a real call has been taught the wrong lesson with
 * confidence. The trainer says so in those words rather than implying a
 * grade it cannot give.
 */
export function checkSpokenAnswer(text: string): SpokenCheck {
  const trimmed = text.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const blocking = copyViolations(trimmed, "Your answer", 1200);
  const notes: string[] = [];

  if (words > 0 && words < MIN_WORDS) {
    notes.push("That is very short. Say the whole thing, the way you would to a person.");
  }
  if (words > LONG_WORDS) {
    notes.push(
      "That is long enough that you would paraphrase it on a real call, and then nobody knows what was said.",
    );
  }
  if (words >= MIN_WORDS && !/[?]/.test(trimmed)) {
    notes.push("No question in there. Worth checking that was deliberate: a question hands the call back to them.");
  }
  return { blocking, notes, wordCount: words };
}

/** The self-assessment after `your_words`. Judgement a machine cannot make,
 *  put to the rep as questions rather than pretended to be a score. */
export const SELF_CHECKS: { id: string; ask: string }[] = [
  { id: "conceded", ask: "Did you concede what was true before you added anything?" },
  { id: "customer", ask: "Did you describe their CUSTOMER's behaviour rather than a failing of theirs?" },
  { id: "one_thing", ask: "Did you teach exactly one thing, rather than three?" },
  { id: "room", ask: "Did you leave them room to answer, instead of talking to the end?" },
  { id: "named_move", ask: "Can you name which of the four moves you just made?" },
];

/** Re-exported so the objection trainer's own callers and tests keep one
 *  import site. The implementations live in ./training/drills, shared with
 *  the Training drills, because two copies of this logic are two places a
 *  drill can grow two right answers. */
export { rng, shuffle, buildOptions, OPTION_COUNT };
export type { DrillOption };
