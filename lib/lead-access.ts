import "server-only";
import { getRecord, type TenantRecord } from "@/lib/manifest/data";
import { canViewLead, leadScopingEnabled, type LeadViewer } from "@/lib/lead-scope";
import { canWriteCrm } from "@/lib/role-gates";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import {
  canMutateOasisSalesRecord,
  canOpenOasisSalesRecord,
  roleMayOperateOasisSalesLead,
} from "@/lib/oasis-sales-pipeline-policy";
import { canReadOasisSalesTeamPipeline } from "@/lib/role-surfaces";
import { getOasisSalesRepRoster, tenantSlugFor } from "@/lib/team";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WritableLeadResult =
  | { ok: true; record: { id: string; data: Record<string, unknown> } }
  | { ok: false; reason: "role_denied" | "not_found" };

export type LeadMutationActor = {
  teamRole: string | null | undefined;
  userId: string | null;
  isOwner?: boolean;
  adminAccess?: boolean;
};

/** Pure policy used by both single-record and bulk generic mutations. */
export function canMutateGenericLeadForTenant(
  actor: LeadMutationActor,
  record: { id: string; data: Record<string, unknown> },
): boolean {
  const role = (actor.teamRole || "").trim().toLowerCase();
  const admin = actor.isOwner === true || actor.adminAccess === true || role === "owner" || role === "admin";
  if (admin) return true;
  if (!canWriteCrm(role)) return false;
  // OASIS job-title roles are globally ownership-scoped. If one is ever
  // mis-provisioned onto a foreign tenant, failing narrower is safer than
  // making a missing/unknown tenant slug a tenant-wide write grant. SunBiz's
  // actual member/loan_officer/processor roles retain their shared CRM model.
  if (!roleMayOperateOasisSalesLead(role)) return true;
  return canMutateOasisSalesRecord(record, {
    role,
    userId: actor.userId,
    isOwner: actor.isOwner,
    adminAccess: actor.adminAccess,
  });
}

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
  actor: LeadMutationActor,
  input: { tenantId: string; entity?: "lead" | "application"; id: string },
): Promise<WritableLeadResult> {
  const role = (actor.teamRole || "").trim().toLowerCase();
  const admin = actor.isOwner === true || actor.adminAccess === true || role === "owner" || role === "admin";
  if (!admin && !canWriteCrm(actor.teamRole)) return { ok: false, reason: "role_denied" };
  const entity = input.entity || "lead";
  const rec = await getRecord({ tenant_id: input.tenantId, entity, id: input.id }).catch(() => null);
  if (!rec) return { ok: false, reason: "not_found" };
  const record = { id: rec.id, data: rec.data as Record<string, unknown> };

  if (!canMutateGenericLeadForTenant(actor, record)) {
    // Missing and not-yours are intentionally indistinguishable to prevent a
    // known-id mutation route from becoming a tenant lead oracle.
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, record };
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

export type LeadReadSession = {
  tenantId: string;
  teamRole: string;
  isAdmin: boolean;
  userId: string | null;
};

export type LeadReadPolicy =
  | { mode: "admin" }
  | { mode: "legacy"; userId: string | null }
  | { mode: "oasis"; role: string; userId: string | null; readableRepUserIds: string[] }
  | { mode: "denied" };

/** Apply a resolved read policy to a tenant-scoped record already in memory. */
export function canReadLeadRecordWithPolicy(
  access: LeadReadPolicy,
  row: { id: string; data: Record<string, unknown> },
): boolean {
  return (
    access.mode === "admin" ||
    (access.mode === "legacy" &&
      canViewLead({ isAdmin: false, userId: access.userId }, row.data, leadScopingEnabled())) ||
    (access.mode === "oasis" &&
      canOpenOasisSalesRecord(row, {
        role: access.role,
        userId: access.userId,
        readableRepUserIds: access.readableRepUserIds,
      }))
  );
}

/** Resolve tenant/role/roster once so an aggregated detail read can reuse it. */
export async function resolveLeadReadPolicy(session: LeadReadSession): Promise<LeadReadPolicy> {
  if (session.isAdmin) return { mode: "admin" };
  if (!session.tenantId) return { mode: "denied" };

  const role = session.teamRole.trim().toLowerCase();
  const slug = await tenantSlugFor(session.tenantId);
  const oasisJobRole = roleMayOperateOasisSalesLead(role);
  // Existing OASIS `member` seats are grandfathered pipeline administrators in
  // isOasisPipelineAdmin. Keep adjacent APIs aligned with that live contract;
  // new OASIS invites no longer offer this ambiguous legacy role.
  if (isWebsiteSalesTenantSlug(slug) && role === "member") {
    return { mode: "admin" };
  }
  if (!isWebsiteSalesTenantSlug(slug) && !oasisJobRole) {
    return { mode: "legacy", userId: session.userId };
  }
  if (!oasisJobRole) return { mode: "denied" };

  const managerTeamRead = canReadOasisSalesTeamPipeline({ teamRole: role, tenantSlug: slug });
  const roster = managerTeamRead
    ? await getOasisSalesRepRoster(session.tenantId).catch(() => [])
    : [];
  return {
    mode: "oasis",
    role,
    userId: session.userId,
    readableRepUserIds: roster.flatMap((member) => {
      const id = member.auth_user_id?.trim().toLowerCase();
      return id ? [id] : [];
    }),
  };
}

function targetFromRecord(
  input: { id: string; entityParam?: string | null },
  data: Record<string, unknown>,
): LeadAccessTarget {
  const entity: "lead" | "application" =
    input.entityParam === "application" ? "application" : "lead";
  if (entity === "lead") {
    return { recordId: input.id, entity, queryLeadId: input.id, stageLeadId: input.id };
  }
  const linked = data.lead_id;
  const stageLeadId = typeof linked === "string" && UUID_RE.test(linked) ? linked : null;
  return { recordId: input.id, entity, queryLeadId: stageLeadId || input.id, stageLeadId };
}

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
  return targetFromRecord(input, rec.data as Record<string, unknown>);
}

/**
 * Read target for lead-adjacent GET routes (timeline, notes, document list and
 * byte delivery). For every ordinary role this preserves the existing shared
 * CRM policy. A non-admin OASIS manager is deliberately special: filter mode
 * must not turn a known id into tenant-wide read access, so the server proves
 * the OASIS tenant, canonical rep roster, and this record's assigned_to before
 * returning a target. Client-supplied rep ids are never accepted.
 */
export async function getReadableLeadTargetForSession(
  session: LeadReadSession,
  input: { tenantId: string; id: string; entityParam?: string | null },
  policy?: LeadReadPolicy,
): Promise<LeadAccessTarget | null> {
  const resolved = await getReadableLeadRecordForSession(session, input, policy);
  return resolved?.target || null;
}

/** Same boundary as getReadableLeadTargetForSession, returning the fetched row. */
export async function getReadableLeadRecordForSession(
  session: LeadReadSession,
  input: { tenantId: string; id: string; entityParam?: string | null },
  policy?: LeadReadPolicy,
): Promise<{ target: LeadAccessTarget; record: TenantRecord } | null> {
  if (!session.tenantId || session.tenantId !== input.tenantId) return null;
  const access = policy || (await resolveLeadReadPolicy(session));
  if (access.mode === "denied") return null;
  const entity: "lead" | "application" =
    input.entityParam === "application" ? "application" : "lead";
  const rec = await getRecord({ tenant_id: session.tenantId, entity, id: input.id }).catch(() => null);
  if (!rec) return null;
  const row = { id: rec.id, data: rec.data as Record<string, unknown> };
  const allowed = canReadLeadRecordWithPolicy(access, row);
  if (!allowed) return null;
  return { target: targetFromRecord(input, row.data), record: rec };
}
