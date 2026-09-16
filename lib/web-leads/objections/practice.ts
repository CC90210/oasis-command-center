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

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded rather than Math.random so a drill is reproducible: a test can assert
 * the shape of round 7 of seed 42, and a rep who reloads gets the same
 * question rather than a reshuffle that hides whether they had learned it.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with the supplied generator. Returns a new array. */
export function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type DrillOption = { id: string; text: string; correct: boolean };

export type Drill = {
  kind: DrillKind;
  slug: string;
  says: string;
  /** Null for `your_words`, which has nothing to choose between. */
  options: DrillOption[] | null;
  /** Shown only after the rep has answered. */
  reveal: { label: string; text: string }[];
};

/** How many options a multiple-choice drill offers, including the right one. */
export const OPTION_COUNT = 4;

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
  const seen = new Set([correctText.trim()]);
  const decoys: PracticeObjection[] = [];
  for (const candidate of shuffle(pool, next)) {
    if (decoys.length >= OPTION_COUNT - 1) break;
    if (candidate.slug === target.slug) continue;
    const text = candidate[field].trim();
    if (seen.has(text)) continue;
    seen.add(text);
    decoys.push(candidate);
  }

  const options = shuffle(
    [
      { id: target.slug, text: correctText, correct: true },
      ...decoys.map((d) => ({ id: d.slug, text: d[field], correct: false })),
    ],
    next,
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
