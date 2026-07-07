import "server-only";
import { getRecord } from "@/lib/manifest/data";
import { canViewLead, leadScopingEnabled, type LeadViewer } from "@/lib/lead-scope";
import { canWriteCrm } from "@/lib/role-gates";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WritableLeadResult =
  | { ok: true; record: { id: string; data: Record<string, unknown> } }
  | { ok: false; reason: "role_denied" | "not_found" };

/**
 * WRITE-mode access gate for CRM data-action endpoints (2026-07-07, CC directive
 * — the "member can't be assigned a lead" bug).
 *
 * Unlike getAccessibleLead (which gates on canViewLead — owner/collaborator
 * VISIBILITY, so it silently narrows members to their own book once
 * LEAD_SCOPING_ENABLED flips on), this gates on the CRM-WRITE ROLE tier: any
 * non-read_only member may act on ANY lead/application in their OWN tenant.
 * The record fetch is tenant-scoped (getRecord takes tenant_id), so tenant
 * isolation is preserved; this only removes the owner-only restriction that
 * blocked members from their daily CRM work.
 *
 * Returns a discriminated result so the caller emits the right status:
 *   { ok:false, reason:"role_denied" } → 403 (read_only / unresolved role)
 *   { ok:false, reason:"not_found" }   → 404 (missing / wrong tenant)
 *
 * Use for owner-gated CRM ACTIONS (assign, set-stage, promote, e-sign, PDFs,
 * create-application). Do NOT use for automation / per-lead-AI endpoints — those
 * stay owner/admin (isAdmin), unchanged.
 */
export async function getWritableLead(
  actor: { teamRole: string | null | undefined },
  input: { tenantId: string; entity?: "lead" | "application"; id: string },
): Promise<WritableLeadResult> {
  if (!canWriteCrm(actor.teamRole)) return { ok: false, reason: "role_denied" };
  const entity = input.entity || "lead";
  const rec = await getRecord({ tenant_id: input.tenantId, entity, id: input.id }).catch(() => null);
  if (!rec) return { ok: false, reason: "not_found" };
  return { ok: true, record: { id: rec.id, data: rec.data as Record<string, unknown> } };
}

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
