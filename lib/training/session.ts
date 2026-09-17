/**
 * Turning curriculum items into a run of questions.
 *
 * Pure, and seeded, for the same reasons `lib/training/drills.ts` is: a rep who
 * reloads gets the same question rather than a reshuffle that hides whether
 * they had learned it, and a test can assert the shape of a specific round.
 */

import { ITEMS } from "@/lib/training/items";
import { buildOptions, rng, shuffle } from "@/lib/training/drills";
import type { DrillItem, Provenance, SectionSlug } from "@/lib/training/types";

/** An option, carrying the sentence shown when a rep picks it. */
export type TrainingOption = {
  id: string;
  text: string;
  correct: boolean;
  /** Why THIS option is wrong. Absent on the right one, which carries
   *  `whyRight` on the drill instead. */
  whyWrong?: string;
  /** The rep mistake this option embodies, for the manager view later. */
  realError?: string;
};

export type TrainingDrill = {
  itemId: string;
  section: SectionSlug;
  unit: string;
  stem: string;
  options: TrainingOption[];
  /** Shown after answering, whichever option was picked. */
  whyRight: string;
  answer: string;
  source: string;
  provenance: Provenance;
};

/** Separates an item id from its distractor index. Chosen because no item id
 *  contains it, which `tests/training-drills.test.ts` asserts rather than
 *  assumes: a collision would make a wrong option grade as the right one. */
export const DISTRACTOR_MARK = "::d";

/**
 * One question for one item.
 *
 * DECOYS ARE THE ITEM'S OWN, AUTHORED ONES. Until 2026-09-17 they were drawn
 * from other items in the same group, which is cheap and produces the quiz Adon
 * rejected: four offer labels competing with each other tests whether a rep
 * memorised four labels. It also cannot say why a chosen wrong answer is wrong,
 * because nobody had written that sentence. Both are fixed by authoring them.
 *
 * The limit is the item's own distractor count rather than OPTION_COUNT, so an
 * author who wrote three genuine wrong answers gets three. The lint enforces
 * the ceiling at authoring time (`authoring-rules.ts`, A1), which is where a
 * padded question should be caught, rather than silently here.
 */
export function buildTrainingDrill(item: DrillItem, next: () => number): TrainingDrill {
  const candidates = item.distractors.map((d, i) => ({
    id: `${item.id}${DISTRACTOR_MARK}${i}`,
    text: d.text,
  }));
  const options = buildOptions(
    { id: item.id, text: item.answer },
    candidates,
    next,
    candidates.length + 1,
  ).map<TrainingOption>((o) => {
    if (o.correct) return { id: o.id, text: o.text, correct: true };
    const index = Number(o.id.slice(o.id.lastIndexOf(DISTRACTOR_MARK) + DISTRACTOR_MARK.length));
    const d = item.distractors[index];
    return { id: o.id, text: o.text, correct: false, whyWrong: d?.whyWrong, realError: d?.realError };
  });
  return {
    itemId: item.id,
    section: item.section,
    unit: item.unit,
    stem: item.stem,
    options,
    whyRight: item.whyRight,
    answer: item.answer,
    source: item.source,
    provenance: item.provenance,
  };
}

/**
 * A run of questions.
 *
 * Covers EVERY item in scope rather than sampling. The items a rep would skip
 * are the ones they are worst at, and a sampling drill lets them never meet
 * those. A fixed set also means "I finished it" is a fact rather than a feeling.
 */
export function buildTrainingSession(
  scope: SectionSlug | "all",
  seed: number,
): TrainingDrill[] {
  const pool = scope === "all" ? ITEMS : ITEMS.filter((i) => i.section === scope);
  const next = rng(seed);
  return shuffle(pool, next).map((item) => buildTrainingDrill(item, next));
}

/** A run over one unit, which is the size a rep is meant to finish in a sitting. */
export function buildUnitSession(unit: string, seed: number): TrainingDrill[] {
  const next = rng(seed);
  return shuffle(ITEMS.filter((i) => i.unit === unit), next).map((item) =>
    buildTrainingDrill(item, next),
  );
}

export type Grade =
  | { ok: true; correct: boolean; sectionSlug: SectionSlug }
  | { ok: false; reason: "unknown_item" | "section_mismatch" };

/**
 * Whether a chosen option was the right one, decided from the CURRICULUM
 * rather than from a flag in the request body.
 *
 * 🚨 WHAT THIS IS NOT: a security boundary. Stated plainly because an earlier
 * version of this comment claimed it was, and that claim was wrong.
 *
 * Both `itemId` and `chosenOptionId` come from the client, and the browser
 * already knows every option id, so anyone willing to open devtools can post
 * the same id as both and be graded correct. This check cannot establish that
 * a human answered a question that was actually put to them, and nothing that
 * grades a CLIENT-BUILT drill can: the questions are generated in the browser
 * from static curriculum, so there is no server-issued challenge to bind an
 * answer to. Making it unforgeable means the server issuing each question,
 * which is a request per question and a different design.
 *
 * WHAT IT DOES BUY, which is why it is still here rather than being dropped as
 * theatre: the previous version took `correct: boolean` from the body, so any
 * bug in the client, any retry, any reordered state update could silently
 * record a wrong answer as right. Correctness now has exactly one definition
 * and it lives next to the curriculum. That is an integrity property, not an
 * anti-cheat one.
 *
 * THE THREAT IT DOES NOT ADDRESS, so nobody is surprised by it: an
 * authenticated rep deliberately faking their own practice record. Managers
 * read these numbers, so that matters, and the decision about whether it is
 * worth a per-question round trip is recorded in ACTIVE_WORK rather than
 * quietly answered here.
 *
 * An unknown item is REFUSED rather than recorded. The read side still
 * tolerates rows whose item was later reworded or removed, because a rep's
 * history is worth keeping; but a write that cannot be checked at all is one
 * nobody can trust.
 */
export function gradeAnswer(itemId: string, sectionSlug: string, chosenOptionId: string): Grade {
  const item = ITEMS.find((i) => i.id === itemId);
  if (!item) return { ok: false, reason: "unknown_item" };
  if (item.section !== sectionSlug) return { ok: false, reason: "section_mismatch" };
  return { ok: true, correct: chosenOptionId === item.id, sectionSlug: item.section };
}

/**
 * Items that cannot make a real question, surfaced by a test rather than left
 * for a rep to meet.
 *
 * This used to count GROUP members, because a group supplied the decoys. Now
 * that distractors are authored per item, the thing that can go wrong is an
 * item written without enough of them, so that is what this counts.
 */
export function underpoweredItems(minDistractors = 2): string[] {
  return ITEMS.filter((i) => i.distractors.length < minDistractors)
    .map((i) => i.id)
    .sort();
}
