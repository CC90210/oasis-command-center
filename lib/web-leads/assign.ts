/**
 * lib/web-leads/assign.ts — give a Web Leads territory to a rep.
 *
 * `leadgen_territories.assigned_to` already exists and is already honoured
 * on read: lib/web-leads/data.ts's visibleToViewer() scopes a non-admin
 * `agent` viewer to leads whose OWN `data.assigned_to` matches them. What's
 * missing is the write — nothing has ever set either column, which is why a
 * freshly-added contractor logs in and sees zero leads (fail closed by
 * design, per the Viewer doc comment in data.ts). assignTerritory() is that
 * missing write.
 *
 * Two writes, not one atomic transaction:
 *   1. leadgen_territories.assigned_to — the sheet's future inheritance.
 *   2. data.assigned_to on each untouched pool lead the territory currently
 *      holds — so the rep can see new inventory today without stealing active
 *      work or rewriting frozen commission provenance.
 *
 * (2) is NOT a single bulk UPDATE. Every lead carries a different `data`
 * JSON blob, so the canonical ownership stamp must be merged into each row
 * without losing its contact and research context. A territory can hold hundreds of
 * leads, so those writes run in bounded batches (ASSIGN_BATCH_SIZE) — a
 * failed batch does not abort the rest, and the result reports exactly how
 * many leads actually updated vs. how many didn't, rather than claiming
 * full success when part of the propagation silently failed. See
 * "A half-assigned territory that reports success is worse than an error"
 * in the Build B spec.
 *
 * UNASSIGNMENT (assignedTo: null) intentionally skips step 2 entirely.
 * Clearing a territory's owner must not rip a lead out from under a rep
 * mid-call — it only clears the sheet's FUTURE inheritance. A lead someone
 * is already working keeps its `data.assigned_to` until it is explicitly
 * reassigned (to someone else, or back to null via a per-lead path — this
 * module never writes null onto a lead).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "./data";
// The one definition of program membership, shared with claim.ts and with
// filterWebsiteSalesRows -- so the two doors into ownership cannot disagree
// about what makes a lead visible on /pipeline. See withAssignedTo below.
import { claimPatch } from "./claim";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A single territory should never hold anywhere near this many leads.
 * Hitting the cap means the read may be truncated (same doctrine as
 * LEAD_READ_CAP in data.ts) — propagating against a possibly-partial list
 * would silently miss leads and still report success, so this refuses
 * instead.
 */
export const TERRITORY_LEAD_CAP = 20000;

/** Leads are written one at a time (each carries different `data`), in
 *  bounded groups run concurrently — small enough that one bad batch can't
 *  take the rest down with it, big enough that a few hundred leads don't
 *  mean a few hundred sequential round trips. */
export const ASSIGN_BATCH_SIZE = 40;

export type AssignResult =
  | {
      ok: true;
      mode: "assigned";
      territoryId: string;
      assignedTo: string;
      leadsMatched: number;
      leadsUpdated: number;
      leadsSkipped: number;
      leadsRaced: number;
      leadsFailed: number;
      trackingFailed: number;
      message: string;
    }
  | {
      ok: true;
      mode: "unassigned";
      territoryId: string;
      assignedTo: null;
      leadsPreserved: number | null;
      message: string;
    }
  | { ok: false; status: number; error: string };

type LeadRow = { id: string; data: Record<string, unknown>; updated_at: string };

/**
 * Territory propagation is an intake operation, never a reassignment tool.
 * Only unowned blank/unassigned/researched rows may enter a rep's book. DNC
 * rows and every active/closed/delivery row are protected from any write.
 */
export function isTerritoryAssignmentEligible(data: Record<string, unknown>): boolean {
  const stage = typeof data.stage === "string" ? data.stage.trim().toLowerCase() : "";
  const assignedTo = typeof data.assigned_to === "string" ? data.assigned_to.trim() : "";
  const isDnc = data.dnc === true || data.dnc === 1;
  return !assignedTo && !isDnc && (!stage || stage === "unassigned" || stage === "researched");
}

export function withAssignedTo(
  data: Record<string, unknown>,
  assignedTo: string,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  if (!isTerritoryAssignmentEligible(data)) return { ...data };
  const durableSourceId =
    typeof data.sourced_by_user_id === "string"
      ? data.sourced_by_user_id.trim().toLowerCase()
      : "";
  const hasFrozenSelfSource =
    data.lead_source_track === "self" && isUuid(durableSourceId);
  return {
    ...data,
    ...claimPatch(assignedTo, nowIso),
    // Untouched territory inventory is company-provided unless it already
    // carries a valid immutable source identity. The new assignee never
    // inherits somebody else's find+close rate.
    lead_source_track: hasFrozenSelfSource ? "self" : "company",
    sourced_by_user_id: hasFrozenSelfSource
      ? durableSourceId
      : Object.prototype.hasOwnProperty.call(data, "sourced_by_user_id")
        ? data.sourced_by_user_id
        : null,
  };
}

export async function assignTerritory(
  input: { territoryId: string; assignedTo: string | null; actorUserId: string },
  db: SupabaseClient = getServiceSupabase(),
): Promise<AssignResult> {
  const territoryId = input.territoryId;
  if (!isUuid(territoryId)) return { ok: false, status: 400, error: "invalid_territory_id" };

  const assignedTo = input.assignedTo === null ? null : input.assignedTo.trim().toLowerCase();
  if (assignedTo !== null && !isUuid(assignedTo)) {
    return { ok: false, status: 400, error: "invalid_assigned_to" };
  }
  const actorUserId = input.actorUserId.trim().toLowerCase();
  if (!isUuid(actorUserId)) {
    return { ok: false, status: 400, error: "invalid_actor_user_id" };
  }

  // Validate the assignee is actually a member of this tenant BEFORE
  // touching leadgen_territories — an invalid assignee must never be
  // partially applied.
  if (assignedTo) {
    const member = await db
      .from("user_profiles")
      .select("auth_user_id")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("auth_user_id", assignedTo)
      .maybeSingle();
    if (member.error) {
      return { ok: false, status: 500, error: `member_read_failed: ${member.error.message}` };
    }
    if (!member.data) return { ok: false, status: 400, error: "assignee_not_in_tenant" };
  }

  const now = new Date().toISOString();
  // UPDATE ... RETURNING id doubles as the existence check: a territory
  // outside this tenant (or that doesn't exist) matches zero rows, and the
  // route answers 404 rather than silently doing nothing.
  const territoryWrite = await db
    .from("leadgen_territories")
    .update({ assigned_to: assignedTo, assigned_at: assignedTo ? now : null, updated_at: now })
    .eq("id", territoryId)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .select("id");
  if (territoryWrite.error) {
    return { ok: false, status: 500, error: `territory_write_failed: ${territoryWrite.error.message}` };
  }
  if (!territoryWrite.data || (territoryWrite.data as unknown[]).length === 0) {
    return { ok: false, status: 404, error: "territory_not_found" };
  }

  if (!assignedTo) {
    // UNASSIGN: leads keep their current owner. Best-effort count for the
    // message only — a failed count must never read as an error, since the
    // write that actually matters (the territory row) already succeeded.
    const existing = await db
      .from("tenant_records")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .filter("data->>webdev_territory_id", "eq", territoryId);
    const leadsPreserved = existing.error ? null : (existing.count ?? 0);
    return {
      ok: true,
      mode: "unassigned",
      territoryId,
      assignedTo: null,
      leadsPreserved,
      message:
        leadsPreserved === null
          ? "Territory unassigned. Existing lead assignments were left as-is."
          : leadsPreserved > 0
            ? `Territory unassigned. ${leadsPreserved} existing lead${leadsPreserved === 1 ? "" : "s"} keep their current owner.`
            : "Territory unassigned. No leads were assigned yet.",
    };
  }

  // ASSIGN: read every territory row, then propagate only to eligible intake
  // inventory. Protected rows are counted but never sent to an UPDATE.
  const leadsRead = await db
    .from("tenant_records")
    .select("id,data,updated_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .filter("data->>webdev_territory_id", "eq", territoryId)
    .limit(TERRITORY_LEAD_CAP);
  if (leadsRead.error) {
    return {
      ok: true,
      mode: "assigned",
      territoryId,
      assignedTo,
      leadsMatched: 0,
      leadsUpdated: 0,
      leadsSkipped: 0,
      leadsRaced: 0,
      leadsFailed: 0,
      trackingFailed: 0,
      message: `Territory assigned, but reading its leads failed (${leadsRead.error.message}) — no leads were updated. Retry to propagate.`,
    };
  }
  const leads = (leadsRead.data || []) as LeadRow[];
  if (leads.length >= TERRITORY_LEAD_CAP) {
    // A short list that LOOKS complete is worse than a loud failure — refuse
    // to propagate against a possibly-truncated read (same doctrine as
    // LEAD_READ_CAP in data.ts).
    return {
      ok: true,
      mode: "assigned",
      territoryId,
      assignedTo,
      leadsMatched: leads.length,
      leadsUpdated: 0,
      leadsSkipped: 0,
      leadsRaced: 0,
      leadsFailed: leads.length,
      trackingFailed: 0,
      message: `Territory assigned, but it holds ${leads.length}+ leads (over the ${TERRITORY_LEAD_CAP}-row safety cap) — none were updated to avoid a silently-partial propagation.`,
    };
  }

  const eligibleLeads = leads.filter((lead) => isTerritoryAssignmentEligible(lead.data));
  const skipped = leads.length - eligibleLeads.length;
  const successfulLeads: LeadRow[] = [];
  let updated = 0;
  let raced = 0;
  let failed = 0;
  for (const batch of chunk(eligibleLeads, ASSIGN_BATCH_SIZE)) {
    const results = await Promise.allSettled(
      batch.map((lead) =>
        db
          .from("tenant_records")
          .update({ data: withAssignedTo(lead.data, assignedTo, now), updated_at: now })
          .eq("id", lead.id)
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("entity_type", "lead")
          // Never write the stale JSON snapshot over a lead claimed or edited
          // after this territory read. Both predicates are required: owner
          // protects the handoff, updated_at protects every sibling field.
          .eq("updated_at", lead.updated_at)
          .or('data->>assigned_to.is.null,data->>assigned_to.eq.""')
          .select("id"),
      ),
    );
    for (let index = 0; index < results.length; index += 1) {
      const r = results[index];
      if (r.status === "fulfilled" && !r.value.error && (r.value.data as unknown[] | null)?.length === 1) {
        updated += 1;
        successfulLeads.push(batch[index]);
      } else if (r.status === "fulfilled" && !r.value.error) {
        raced += 1;
      } else {
        failed += 1;
      }
    }
  }

  // Only committed ownership changes receive history. Skipped/raced rows did
  // not change, so logging them would create a false audit trail.
  let trackingFailed = 0;
  for (const batch of chunk(successfulLeads, ASSIGN_BATCH_SIZE)) {
    const auditRows = batch.map((lead) => {
      const rawStage = typeof lead.data.stage === "string" ? lead.data.stage.trim() : "";
      const assignedData = withAssignedTo(lead.data, assignedTo, now);
      const content = `Assigned from territory ${territoryId} to ${assignedTo}.`;
      return {
        tenant_id: WEBDEV_TENANT_ID,
        lead_id: lead.id,
        type: "lead_reassigned",
        channel: "system",
        direction: "internal",
        agent_source: "web_leads_territory_assign",
        actor_user_id: actorUserId,
        subject: "Lead assigned from territory",
        content,
        content_preview: content,
        created_at: now,
        metadata: {
          action: "territory_assign",
          territory_id: territoryId,
          from_assigned_to: null,
          assigned_to: assignedTo,
          assigned_by: actorUserId,
          from_stage: rawStage || null,
          to_stage: "assigned",
          lead_source_track: assignedData.lead_source_track,
          sourced_by_user_id: assignedData.sourced_by_user_id,
        },
      };
    });
    try {
      const tracking = await db.from("lead_interactions").insert(auditRows);
      if (tracking.error) {
        trackingFailed += batch.length;
        console.error("[web-leads.territory-assign] ownership changed but audit tracking failed", {
          territoryId,
          leadIds: batch.map((lead) => lead.id),
          error: tracking.error.message,
        });
      }
    } catch (error) {
      trackingFailed += batch.length;
      console.error("[web-leads.territory-assign] ownership changed but audit tracking threw", {
        territoryId,
        leadIds: batch.map((lead) => lead.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const messageParts = [
    `Territory assigned. ${updated} eligible lead${updated === 1 ? "" : "s"} updated.`,
    `${skipped} protected lead${skipped === 1 ? "" : "s"} left unchanged.`,
  ];
  if (raced > 0) {
    messageParts.push(`${raced} changed while assigning and stayed untouched.`);
  }
  if (failed > 0) {
    messageParts.push(`${failed} failed update${failed === 1 ? "" : "s"} need retrying.`);
  }
  if (trackingFailed > 0) {
    messageParts.push(`${trackingFailed} audit entr${trackingFailed === 1 ? "y" : "ies"} failed to record.`);
  }

  return {
    ok: true,
    mode: "assigned",
    territoryId,
    assignedTo,
    leadsMatched: leads.length,
    leadsUpdated: updated,
    leadsSkipped: skipped,
    leadsRaced: raced,
    leadsFailed: failed,
    trackingFailed,
    message: messageParts.join(" "),
  };
}
