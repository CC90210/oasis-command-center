/**
 * lib/drips/accelerated.ts — shared predicate for the accelerated-chase overlap
 * suppression (Adon 2026-07-22: "one track at a time").
 *
 * Stage drips stand down for a lead ONLY while an accelerated chase is ACTUALLY
 * chasing it — i.e. an active (scheduled|sending) drip_run exists on a
 * flag-triggered sequence. The flag alone is NOT enough (codex review P1,
 * 2026-07-22): a flagged lead the chase can't enroll (no phone, shopped
 * lookback, chase sequence disabled) must keep its stage drips, or it would sit
 * on NO track at all. The window between flag-set and first chase enrollment
 * (~one cron tick) intentionally keeps stage drips running for the same reason.
 *
 * Fail-open by design: if the lookup errors, we DON'T suppress — the safe
 * failure is a possible one-off overlap text, never a silently-stranded lead.
 */

import "server-only";
import type { getServiceSupabase } from "@/lib/supabase-server";

type Db = ReturnType<typeof getServiceSupabase>;

export const ACCELERATED_FLAG = "accelerated_followup";

/** Master switch for the whole accelerated system (same env the enroll cron
 *  gates on). While off, overlap suppression is inert so the dormant chase
 *  can't strip stage drips before go-live. */
export function acceleratedSystemLive(): boolean {
  return process.env.ACCELERATED_ENROLL_LIVE === "1";
}

/** Does this lead have an ACTIVE run on THE accelerated chase sequence?
 *  Sequence-first lookup (codex review 2026-07-22, P1+P2): match sequences by
 *  the EXACT trigger field (`accelerated_followup` — some other flag-triggered
 *  sequence must not count as the chase), then check for an active run on just
 *  those ids — exact, no unordered-limit truncation. `enabled` filter aligns
 *  with the executor, which permanently fails runs of a disabled sequence
 *  (executor.ts processRow "sequence_disabled") — a disabled chase can't text
 *  anyone, so it must not suppress the stage drips either. */
export async function hasActiveAcceleratedRun(
  db: Db,
  tenantId: string,
  leadId: string,
): Promise<boolean> {
  try {
    const seqRes = await db
      .from("drip_sequences")
      .select("id, trigger_filter")
      .eq("tenant_id", tenantId)
      .eq("enabled", true);
    const chaseIds = ((seqRes.data || []) as Array<{ id: string; trigger_filter: unknown }>)
      .filter((s) => {
        const tf = s.trigger_filter as { entity?: unknown; field?: unknown; to?: unknown } | null;
        return !!tf && (!tf.entity || tf.entity === "lead") && tf.field === ACCELERATED_FLAG && tf.to === "true";
      })
      .map((s) => s.id);
    if (chaseIds.length === 0) return false;
    const runs = await db
      .from("drip_runs")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .in("sequence_id", chaseIds)
      .in("status", ["scheduled", "sending"])
      .limit(1);
    return ((runs.data || []) as Array<{ id: string }>).length > 0;
  } catch {
    return false; // fail-open: keep the stage drip rather than strand the lead
  }
}
