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
  /**
   * The leads themselves, not just their ids.
   *
   * `data.stage` is required for the "does the deal contradict the lead" test —
   * without it a lead parked at `declined` looks identical to one parked at
   * `signed_application`, and the gate would cancel the deliberate
   * re-engagement drips.
   *
   * `data.application_id` is the OTHER half of the link. See below.
   */
  leads: Array<{ id: string; data: Record<string, unknown> | null }>,
): Promise<DealGateResult> {
  const gates = new Map<string, DealGate>();
  if (leads.length === 0) return { ok: true, gates };

  const byLead = new Map<string, DealRow[]>();
  const alreadyLoaded = new Set<string>(); // application ids seen in the forward pass
  const push = (leadId: string, data: Record<string, unknown>, createdAt: string | null) => {
    const list = byLead.get(leadId) || [];
    list.push({ lead_id: leadId, status: data.status, stage: data.stage, created_at: createdAt });
    byLead.set(leadId, list);
  };

  // ── Link direction 1: the application points at the lead (`data.lead_id`).
  // What `promote-lead-to-application` writes, and how 589 of 1,053
  // applications are linked today.
  const leadIds = leads.map((l) => l.id);
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
      alreadyLoaded.add(row.id);
      push(leadId, data, row.created_at ?? null);
    }
  }

  // ── Link direction 2: the LEAD points at the application
  // (`data.application_id`), with no backlink on the application.
  //
  // A supported one-way shape — see app/api/leads/[id]/application-signature.
  // Relying only on the backlink would let a legacy record read as "no
  // application" and therefore OPEN, which for a suppression guard means
  // emailing a funded merchant (Codex review P1, 2026-08-11). Measured that
  // day: 506 leads carry application_id and all 506 of those applications DO
  // carry the backlink, so this resolves nothing today — it closes the path
  // before a legacy or hand-made row walks through it.
  // ALWAYS resolved, never skipped when the forward query already found
  // something for this lead. Skipping it as an optimisation was itself a bug
  // (Codex review P1, round 4): a re-applying lead has `application_id` on the
  // CURRENT deal while an OLD application still carries the backlink, so the
  // shortcut fed dealGateFor only the stale row — and that inverts the exact
  // re-application rule dealGateFor exists to enforce. An old decline would
  // then mute a live deal, or an old open status would permit mail after the
  // current one closed. Load both and let the newest-row reduction decide.
  const reverse = new Map<string, string>(); // application id -> lead id
  for (const lead of leads) {
    const appId = (lead.data || {}).application_id;
    if (typeof appId === "string" && appId.trim()) reverse.set(appId.trim(), lead.id);
  }
  // The only rows worth skipping are ones the forward pass ALREADY pushed —
  // a doubly-linked application would otherwise be counted twice. Skipping by
  // application id is safe; skipping by lead id is what caused the bug above.
  const appIds = [...reverse.keys()].filter((id) => !alreadyLoaded.has(id));
  for (let i = 0; i < appIds.length; i += LEAD_CHUNK) {
    const res = await db
      .from("tenant_records")
      .select("id, data, created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "application")
      .in("id", appIds.slice(i, i + LEAD_CHUNK));
    if (res.error) return { ok: false, error: res.error.message };
    for (const row of (res.data || []) as Array<{
      id: string;
      data: Record<string, unknown> | null;
      created_at?: string | null;
    }>) {
      const leadId = reverse.get(row.id);
      if (!leadId) continue;
      push(leadId, row.data || {}, row.created_at ?? null);
    }
  }

  const stageByLead = new Map(leads.map((l) => [l.id, (l.data || {}).stage]));
  for (const [leadId, rows] of byLead) gates.set(leadId, dealGateFor(rows, stageByLead.get(leadId)));
  return { ok: true, gates };
}

/** Convenience for the single-lead dispatch path. Same failure contract. */
export async function loadDealGate(
  db: Db,
  tenantId: string,
  leadId: string,
  leadData: Record<string, unknown> | null,
): Promise<{ ok: true; gate: DealGate } | { ok: false; error: string }> {
  const res = await loadDealGates(db, tenantId, [{ id: leadId, data: leadData }]);
  if (!res.ok) return res;
  return { ok: true, gate: res.gates.get(leadId) ?? { open: true, reason: "no_application" } };
}
