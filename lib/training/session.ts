/**
 * Turning curriculum items into a run of questions.
 *
 * Pure, and seeded, for the same reasons `lib/training/drills.ts` is: a rep who
 * reloads gets the same question rather than a reshuffle that hides whether
 * they had learned it, and a test can assert the shape of a specific round.
 */

import { ITEMS, groupPeers } from "@/lib/training/items";
import { buildOptions, rng, shuffle, type DrillOption } from "@/lib/training/drills";
import type { DrillItem, SectionSlug } from "@/lib/training/types";

export type TrainingDrill = {
  itemId: string;
  section: SectionSlug;
  prompt: string;
  options: DrillOption[];
  /** Shown after answering. */
  because: string;
  answer: string;
};

/**
 * One question for one item.
 *
 * Decoys come from the item's OWN group, which is what makes the question worth
 * asking: the four offer labels compete with each other rather than with a
 * buyer level.
 *
 * An item whose group has no peers yields a single-option question rather than
 * being padded with unrelated text. That is visible and fixable; a question
 * quietly padded with a wrong answer from another subject is neither.
 */
export function buildTrainingDrill(item: DrillItem, next: () => number): TrainingDrill {
  const peers = groupPeers(item).map((p) => ({ id: p.id, text: p.answer }));
  return {
    itemId: item.id,
    section: item.section,
    prompt: item.prompt,
    options: buildOptions({ id: item.id, text: item.answer }, peers, next),
    because: item.because,
    answer: item.answer,
  };
}

/**
 * A run of questions.
 *
 * Covers EVERY item in scope rather than sampling. The items a rep would skip
 * are the ones they are worst at, and a sampling drill lets them never meet
 * those. A fixed set also means "I finished it" is a fact rather than a feeling.
 */
export function buildTrainingSession(section: SectionSlug | "all", seed: number): TrainingDrill[] {
  const pool = section === "all" ? ITEMS : ITEMS.filter((i) => i.section === section);
  const next = rng(seed);
  return shuffle(pool, next).map((item) => buildTrainingDrill(item, next));
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

/** Items whose group is too small to make a real question. Surfaced by a test
 *  rather than left to be noticed by a rep answering a one-option drill. */
export function underpoweredGroups(minPeers = 2): string[] {
  const counts = new Map<string, number>();
  for (const i of ITEMS) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n < minPeers).map(([g]) => g).sort();
}
