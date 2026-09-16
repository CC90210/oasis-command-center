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
 * Whether a chosen option was the right one, decided from the CURRICULUM.
 *
 * 🚨 THE CLIENT DOES NOT GET TO SAY. An earlier version of the progress
 * endpoint took a `correct: boolean` from the request body, which meant a
 * modified client or a plain curl could award itself a perfect record without
 * answering anything. That is not a theoretical problem here: managers read
 * this progress, so a forged record is worse than no record, and a manager
 * signing off onboarding against it would be signing off nothing.
 *
 * The option ids ARE item ids. `buildTrainingDrill` labels the correct option
 * with the item's own id and every decoy with a peer item's id, so comparing
 * the chosen id to the item id is the whole check, and it needs nothing the
 * server does not already have.
 *
 * An unknown item is REFUSED rather than recorded. The read side still
 * tolerates rows whose item was later reworded or removed, because a rep's
 * history is worth keeping; but a write that cannot be checked is a write
 * nobody can trust, and the only thing it could add is a forged one.
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
