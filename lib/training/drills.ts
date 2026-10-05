/**
 * The generic drill machinery: seeded shuffling, and assembling a set of
 * options where exactly one is right.
 *
 * EXTRACTED, NOT FORKED. This logic was written for the objection trainer
 * (`lib/web-leads/objections/practice.ts`) and Training needs the same thing
 * for a different kind of question. Copying it would create a second place a
 * drill can grow two right answers, and the two copies would drift the first
 * time one was fixed. The objection trainer now imports from here.
 *
 * WHY SEEDED. A drill has to be reproducible. A rep who reloads should get the
 * same question rather than a reshuffle that hides whether they had learned it,
 * and a test has to be able to assert the shape of round seven of seed
 * forty-two. Nothing in this file reads `Math.random`, the clock, or anything
 * else outside its arguments.
 *
 * THE ONE INVARIANT WORTH THE FILE: `buildOptions` returns exactly one correct
 * option and never repeats an option's text. A question with two right answers
 * looks completely normal to the person answering it, marks them wrong for a
 * correct choice, and teaches the opposite of what it meant to.
 */

/** Deterministic PRNG (mulberry32). Same seed, same sequence, forever. */
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

/** How many options a multiple-choice drill offers, including the right one. */
export const OPTION_COUNT = 4;

/**
 * One correct option plus decoys drawn from `candidates`, shuffled.
 *
 * DECOYS ARE REAL CONTENT, never invented. A plausible wrong answer has to be
 * something the learner could genuinely confuse with the right one; made-up
 * decoys are eliminated on style alone and the question stops testing anything.
 *
 * DEDUPLICATED BY TEXT, not by id. Two curriculum items occasionally carry
 * almost the same sentence, and offering it twice, one marked correct and one
 * not, marks a learner wrong for picking identical words. Text is what they
 * read, so text is what has to be unique.
 *
 * Fewer candidates than `limit` yields a SHORTER question, never a padded or
 * duplicated one.
 */
export function buildOptions(
  correct: { id: string; text: string },
  candidates: readonly { id: string; text: string }[],
  next: () => number,
  limit = OPTION_COUNT,
): DrillOption[] {
  const seen = new Set([correct.text.trim()]);
  const decoys: { id: string; text: string }[] = [];
  for (const candidate of shuffle(candidates, next)) {
    if (decoys.length >= Math.max(0, limit - 1)) break;
    if (candidate.id === correct.id) continue;
    const text = candidate.text.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    decoys.push(candidate);
  }
  return shuffle(
    [
      { id: correct.id, text: correct.text, correct: true },
      ...decoys.map((d) => ({ id: d.id, text: d.text, correct: false })),
    ],
    next,
  );
}
