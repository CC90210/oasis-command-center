import "server-only";
import { getRecord } from "@/lib/manifest/data";
import { canViewLead, leadScopingEnabled, type LeadViewer } from "@/lib/lead-scope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single-lead access gate for the /api/leads/[id]/* routes (Adon Batch 2).
 * Fetches the lead/application and confirms the viewer may access it — admin,
 * or the agent it's assigned to. Returns the record, or null when it's missing
 * OR access-denied; callers return 404 either way so a non-owner can't even
 * confirm the record exists.
 *
 * Server-only (imports the DB layer) — kept separate from lib/lead-scope.ts so
 * that module stays pure + unit-testable.
 */
export async function getAccessibleLead(
  viewer: LeadViewer,
  input: { tenantId: string; entity?: "lead" | "application"; id: string },
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const entity = input.entity || "lead";
  const rec = await getRecord({ tenant_id: input.tenantId, entity, id: input.id }).catch(() => null);
  if (!rec) return null;
  const data = rec.data as Record<string, unknown>;
  if (!canViewLead(viewer, data, leadScopingEnabled())) return null;
  return { id: rec.id, data };
}

export type LeadAccessTarget = {
  /** The record id from the route ([id]) — a lead OR an application id. */
  recordId: string;
  entity: "lead" | "application";
  /**
   * The id to filter lead_id-keyed feeds by (lead_documents, lead_interactions,
   * timeline, notes). For a lead this is the record id; for an application it's
   * the LINKED lead id (data.lead_id) so the application drawer surfaces the same
   * documents/timeline/notes the lead carries. Falls back to the record id when
   * an application has no linked lead.
   */
  queryLeadId: string;
  /** The real lead id for stage-engine dispatch — null when an application has
   *  no linked lead (so the caller skips the stage bump rather than dispatch
   *  against an application id the engine can't resolve). */
  stageLeadId: string | null;
};

/**
 * Entity-aware access gate + id resolver shared by the document, timeline, and
 * notes routes (Batch 5 / Codex 2026-06-19 MEDIUM). The drawer opens for BOTH
 * lead and application records and passes its recordId verbatim; a lead-only
 * gate 404s every application drawer's Activity/Notes/Docs. This resolves the
 * correct entity, authorizes it via canViewLead, and returns the lead_id those
 * feeds are actually keyed by — one place, so the three routes can't drift.
 *
 * Returns null when the record is missing OR access-denied; callers 404 either
 * way so a non-owner can't confirm the record exists.
 */
export async function getAccessibleLeadTarget(
  viewer: LeadViewer,
  input: { tenantId: string; id: string; entityParam?: string | null },
): Promise<LeadAccessTarget | null> {
  const entity: "lead" | "application" =
    input.entityParam === "application" ? "application" : "lead";
  const scoping = leadScopingEnabled();
  const rec = await getRecord({ tenant_id: input.tenantId, entity, id: input.id }).catch(() => null);
  if (!rec || !canViewLead(viewer, rec.data as Record<string, unknown>, scoping)) return null;

  if (entity === "lead") {
    return { recordId: input.id, entity, queryLeadId: input.id, stageLeadId: input.id };
  }

  const linked = (rec.data as Record<string, unknown>).lead_id;
  const stageLeadId = typeof linked === "string" && UUID_RE.test(linked) ? linked : null;
  return { recordId: input.id, entity, queryLeadId: stageLeadId || input.id, stageLeadId };
}
