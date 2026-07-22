/**
 * Eager drip cancellation on stage change — the debounce half of the 24h
 * stage-buffer fix (2026-07-22).
 *
 * Before this, cancellation of stale drips happened ONLY lazily inside the
 * dispatch tick (executor.ts stage-recheck), so a pending "old stage" email
 * survived in `drip_runs` until its due time. This module cancels those rows
 * SYNCHRONOUSLY at the stage-write choke point (lib/manifest/data.ts
 * updateRecord), the moment the lead transitions — a fast-moving lead's
 * intermediate-stage sequence is flushed before it can ever fire.
 *
 * Only `status='scheduled'` rows are touched, with a CAS on status so a row
 * the dispatcher just claimed (`sending`) is left alone — the executor's own
 * stage-recheck owns in-flight rows. Only STAGE-triggered sequences are
 * cancelled; flag-triggered chases (e.g. accelerated follow-up) have their own
 * flag-clear lifecycle and are deliberately untouched.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

type RunRow = { id: string; sequence_id: string };
type SequenceTriggerRow = { id: string; trigger_filter: unknown };

/** The stage a sequence's trigger targets, or null when it isn't
 *  stage-triggered (flag sequences, malformed filters). */
export function triggerStageOf(triggerFilter: unknown): string | null {
  if (!triggerFilter || typeof triggerFilter !== "object") return null;
  const f = triggerFilter as Record<string, unknown>;
  if (f.field !== "stage") return null;
  return typeof f.to === "string" && f.to ? f.to : null;
}

/**
 * Pure selection: which scheduled runs are stale for a lead now at `newStage`?
 * `newStage === null` means "cancel every stage-triggered run" (used when a
 * deal is shopped out — no stage sequence should keep nagging).
 * Runs whose sequence is unknown or not stage-triggered are kept.
 */
export function selectStaleRunIds(
  runs: RunRow[],
  sequences: SequenceTriggerRow[],
  newStage: string | null,
): string[] {
  const stageBySeq = new Map<string, string | null>();
  for (const seq of sequences) stageBySeq.set(seq.id, triggerStageOf(seq.trigger_filter));
  const stale: string[] = [];
  for (const run of runs) {
    if (!stageBySeq.has(run.sequence_id)) continue; // unknown sequence — leave for the executor
    const target = stageBySeq.get(run.sequence_id);
    if (target === null || target === undefined) continue; // not stage-triggered
    if (newStage === null || target !== newStage) stale.push(run.id);
  }
  return stale;
}

export type CancelStaleResult =
  | { ok: true; cancelled: number }
  | { ok: false; error: string };

/**
 * Cancel this lead's pending stage-triggered drip runs that no longer match
 * `newStage` (or all of them when `newStage` is null — the shopped-out case).
 *
 * Never throws: a cancellation hiccup must not fail the stage write itself.
 * The dispatch-time stage-recheck remains the backstop for anything missed.
 */
export async function cancelStaleDripRunsForLead(
  db: Db,
  tenantId: string,
  leadId: string,
  newStage: string | null,
  reason: string,
): Promise<CancelStaleResult> {
  try {
    const runsRes = await db
      .from("drip_runs")
      .select("id, sequence_id")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("status", "scheduled");
    if (runsRes.error) return { ok: false, error: runsRes.error.message };
    const runs = (runsRes.data ?? []) as RunRow[];
    if (runs.length === 0) return { ok: true, cancelled: 0 };

    const seqIds = [...new Set(runs.map((r) => r.sequence_id))];
    const seqRes = await db
      .from("drip_sequences")
      .select("id, trigger_filter")
      .in("id", seqIds);
    if (seqRes.error) return { ok: false, error: seqRes.error.message };

    const staleIds = selectStaleRunIds(
      runs,
      (seqRes.data ?? []) as SequenceTriggerRow[],
      newStage,
    );
    if (staleIds.length === 0) return { ok: true, cancelled: 0 };

    // CAS on status: a row the dispatcher claimed between our read and this
    // write stays 'sending' and is handled by the executor's own recheck.
    const cancelRes = await db
      .from("drip_runs")
      .update({ status: "cancelled", last_error: reason.slice(0, 500) })
      .in("id", staleIds)
      .eq("status", "scheduled")
      .select("id");
    if (cancelRes.error) return { ok: false, error: cancelRes.error.message };
    return { ok: true, cancelled: (cancelRes.data ?? []).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cancel_failed" };
  }
}
