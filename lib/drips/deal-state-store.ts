/**
 * lib/drips/deal-state-store.ts — the I/O half of the deal gate.
 *
 * The rule lives in deal-state.ts. This batch-loads the applications linked to
 * a set of leads and reduces each to a gate.
 *
 * FAILURE DIRECTION IS DELIBERATE AND DIFFERENT AT EACH CALL SITE, so this
 * returns the error rather than choosing for the caller:
 *
 *   enrolment  — a read failure SKIPS the lead. Nothing is lost; the next
 *                15-minute tick tries again.
 *   dispatch   — a read failure RESCHEDULES the step. It must never CANCEL,
 *                because a transient database hiccup would otherwise
 *                permanently kill a live sequence.
 *
 * Neither direction sends. That is the point: the gate exists because sending
 * to a closed deal is the expensive mistake.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { dealGateFor, type DealGate, type DealRow } from "./deal-state";

type Db = ReturnType<typeof getServiceSupabase>;

export type DealGateResult =
  | { ok: true; gates: Map<string, DealGate> }
  | { ok: false; error: string };

/** PostgREST `in` lists are URL-encoded into the query string, so a whole
 *  candidate page in one call can exceed the URL length limit. Chunked. */
const LEAD_CHUNK = 100;

/**
 * Load the deal gate for each lead id.
 *
 * Leads with no application row are absent from the returned map; callers
 * treat a missing entry as open, matching `dealGateFor([])`. That keeps the
 * common case — the entire top of the funnel, which has no application at all —
 * free of both a row and a decision.
 */
export async function loadDealGates(
  db: Db,
  tenantId: string,
  leadIds: string[],
  /** lead id -> that lead's current `data.stage`. Required for the
   *  "does the deal contradict the lead" test — without it a lead parked at
   *  `declined` looks identical to one parked at `signed_application`, and the
   *  gate would cancel the deliberate re-engagement drips. */
  stageByLead?: Map<string, unknown>,
): Promise<DealGateResult> {
  const gates = new Map<string, DealGate>();
  if (leadIds.length === 0) return { ok: true, gates };

  const byLead = new Map<string, DealRow[]>();
  for (let i = 0; i < leadIds.length; i += LEAD_CHUNK) {
    const chunk = leadIds.slice(i, i + LEAD_CHUNK);
    const res = await db
      .from("tenant_records")
      .select("id, data, created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "application")
      .in("data->>lead_id", chunk);
    if (res.error) return { ok: false, error: res.error.message };

    for (const row of (res.data || []) as Array<{
      id: string;
      data: Record<string, unknown> | null;
      created_at?: string | null;
    }>) {
      const data = row.data || {};
      const leadId = typeof data.lead_id === "string" ? data.lead_id : "";
      if (!leadId) continue;
      const list = byLead.get(leadId) || [];
      list.push({ lead_id: leadId, status: data.status, stage: data.stage, created_at: row.created_at ?? null });
      byLead.set(leadId, list);
    }
  }

  for (const [leadId, rows] of byLead) gates.set(leadId, dealGateFor(rows, stageByLead?.get(leadId)));
  return { ok: true, gates };
}

/** Convenience for the single-lead dispatch path. Same failure contract. */
export async function loadDealGate(
  db: Db,
  tenantId: string,
  leadId: string,
  leadStage?: unknown,
): Promise<{ ok: true; gate: DealGate } | { ok: false; error: string }> {
  const res = await loadDealGates(db, tenantId, [leadId], new Map([[leadId, leadStage]]));
  if (!res.ok) return res;
  return { ok: true, gate: res.gates.get(leadId) ?? { open: true, reason: "no_application" } };
}
