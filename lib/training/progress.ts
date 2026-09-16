/**
 * Reading and writing a rep's training progress.
 *
 * EVERY QUERY IS TENANT-PINNED. libSQL has no row-level security, so the
 * `tenant_id` in the query is the authorization boundary, not a filter.
 *
 * COUNTERS, INCREMENTED BY READ-THEN-WRITE. libSQL through this client has no
 * atomic increment, so a burst of results from one rep could in principle lose
 * a count. That is accepted deliberately and stated rather than hidden: the
 * number is a practice tally, nobody is paid on it, and the alternative shapes
 * (an append-only event table, or a transaction per keypress) cost more than a
 * dropped count is worth. What must NOT happen is a lost count being mistaken
 * for a wrong answer, so a failed write throws rather than resolving quietly.
 */

import { randomUUID } from "node:crypto";

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { SECTION_SLUGS, type SectionSlug } from "@/lib/training/types";

export class TrainingProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingProgressError";
  }
}

export type ItemProgress = {
  itemId: string;
  sectionSlug: string;
  rightCount: number;
  wrongCount: number;
  lastSeenAt: string;
};

export type SectionCompletion = {
  sectionSlug: string;
  completedAt: string;
  rightCount: number;
  wrongCount: number;
};

type ProgressRow = {
  item_id: string;
  section_slug: string;
  right_count: number;
  wrong_count: number;
  last_seen_at: string;
};

type CompletionRow = {
  section_slug: string;
  completed_at: string;
  right_count: number;
  wrong_count: number;
};

/** One rep's per-item counters. */
export async function fetchProgress(repUserId: string): Promise<ItemProgress[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("training_progress")
    .select("item_id,section_slug,right_count,wrong_count,last_seen_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("rep_user_id", repUserId);
  if (error) throw new TrainingProgressError(`training_progress_read_failed: ${error.message}`);
  return ((data || []) as ProgressRow[]).map((r) => ({
    itemId: r.item_id,
    sectionSlug: r.section_slug,
    rightCount: Number(r.right_count) || 0,
    wrongCount: Number(r.wrong_count) || 0,
    lastSeenAt: r.last_seen_at,
  }));
}

/** One rep's finished sections. */
export async function fetchCompletions(repUserId: string): Promise<SectionCompletion[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("training_completion")
    .select("section_slug,completed_at,right_count,wrong_count")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("rep_user_id", repUserId);
  if (error) throw new TrainingProgressError(`training_completion_read_failed: ${error.message}`);
  return ((data || []) as CompletionRow[]).map((r) => ({
    sectionSlug: r.section_slug,
    completedAt: r.completed_at,
    rightCount: Number(r.right_count) || 0,
    wrongCount: Number(r.wrong_count) || 0,
  }));
}

/**
 * Records one answered question.
 *
 * `sectionSlug` is validated against the curriculum before the write. The item
 * id is not, on purpose: a rep's history of an item that was later reworded or
 * removed is still worth keeping, and the read side ignores rows whose item no
 * longer exists. A section, though, is what a manager reads a total against, so
 * an unknown one would create a bucket nobody can see.
 */
export async function recordAnswer(args: {
  repUserId: string;
  itemId: string;
  sectionSlug: string;
  correct: boolean;
}): Promise<void> {
  if (!(SECTION_SLUGS as readonly string[]).includes(args.sectionSlug)) {
    throw new TrainingProgressError(`unknown_section: ${args.sectionSlug}`);
  }
  if (!args.itemId.trim()) throw new TrainingProgressError("missing_item_id");

  const db = getServiceSupabase();
  const now = new Date().toISOString();

  const existing = await db
    .from("training_progress")
    .select("id,right_count,wrong_count")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("rep_user_id", args.repUserId)
    .eq("item_id", args.itemId)
    .maybeSingle();
  if (existing.error) {
    throw new TrainingProgressError(`training_progress_read_failed: ${existing.error.message}`);
  }

  if (existing.data) {
    const row = existing.data as { id: string; right_count: number; wrong_count: number };
    const { error } = await db
      .from("training_progress")
      .update({
        right_count: (Number(row.right_count) || 0) + (args.correct ? 1 : 0),
        wrong_count: (Number(row.wrong_count) || 0) + (args.correct ? 0 : 1),
        last_seen_at: now,
        updated_at: now,
      })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("id", row.id);
    if (error) throw new TrainingProgressError(`training_progress_update_failed: ${error.message}`);
    return;
  }

  const { error } = await db.from("training_progress").insert({
    id: randomUUID(),
    tenant_id: WEBDEV_TENANT_ID,
    rep_user_id: args.repUserId,
    item_id: args.itemId,
    section_slug: args.sectionSlug,
    right_count: args.correct ? 1 : 0,
    wrong_count: args.correct ? 0 : 1,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  });
  if (error) throw new TrainingProgressError(`training_progress_insert_failed: ${error.message}`);
}

/** Marks a section finished, or updates the score if it is finished again. */
export async function recordCompletion(args: {
  repUserId: string;
  sectionSlug: SectionSlug;
  rightCount: number;
  wrongCount: number;
}): Promise<void> {
  if (!(SECTION_SLUGS as readonly string[]).includes(args.sectionSlug)) {
    throw new TrainingProgressError(`unknown_section: ${args.sectionSlug}`);
  }
  const db = getServiceSupabase();
  const now = new Date().toISOString();

  const existing = await db
    .from("training_completion")
    .select("id")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("rep_user_id", args.repUserId)
    .eq("section_slug", args.sectionSlug)
    .maybeSingle();
  if (existing.error) {
    throw new TrainingProgressError(`training_completion_read_failed: ${existing.error.message}`);
  }

  if (existing.data) {
    const { error } = await db
      .from("training_completion")
      .update({
        right_count: args.rightCount,
        wrong_count: args.wrongCount,
        completed_at: now,
        updated_at: now,
      })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("id", (existing.data as { id: string }).id);
    if (error) throw new TrainingProgressError(`training_completion_update_failed: ${error.message}`);
    return;
  }

  const { error } = await db.from("training_completion").insert({
    id: randomUUID(),
    tenant_id: WEBDEV_TENANT_ID,
    rep_user_id: args.repUserId,
    section_slug: args.sectionSlug,
    completed_at: now,
    right_count: args.rightCount,
    wrong_count: args.wrongCount,
    created_at: now,
    updated_at: now,
  });
  if (error) throw new TrainingProgressError(`training_completion_insert_failed: ${error.message}`);
}
