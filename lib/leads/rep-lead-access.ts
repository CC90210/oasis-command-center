/**
 * "May this session run a per-lead tool on THIS lead?"
 *
 * canWriteCrm answers a role question — is this person allowed to do CRM work
 * at all — and its allowlist predates the OASIS sales titles, so `closer`,
 * `opener`, `manager` and `builder` are absent from it. That is correct for
 * tenant-wide levers (bulk stage moves, sequence management) and wrong for the
 * two buttons on a rep's own lead: a closer opened the deal assigned to them,
 * pressed "Score with AI", and got a 403 for a lead nobody else was working.
 *
 * So the question is asked in two parts: the role may permit it outright, or
 * the ASSIGNMENT may. Widening CRM_WRITE_ROLES instead would have handed those
 * same roles the bulk stage endpoint, which is the one thing CC ruled out.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { canWriteCrm } from "@/lib/role-gates";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import {
  canMutateOasisSalesRecord,
  ownsOasisSalesRecord,
  roleMayOperateOasisSalesLead,
  roleMaySelfEditLead,
} from "@/lib/oasis-sales-pipeline-policy";

export type PerLeadAccess =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string };

export type PerLeadAccessMode = "crm" | "owned_oasis_sales";

/** Shared lead routes keep legacy CRM permissions outside OASIS. */
export function resolvePerLeadAccessPolicy(
  accessMode: PerLeadAccessMode,
  tenantSlug: string | null,
): PerLeadAccessMode {
  if (accessMode === "crm") return "crm";
  return tenantSlug && !isWebsiteSalesTenantSlug(tenantSlug) ? "crm" : "owned_oasis_sales";
}

export async function assertMayWorkLead(args: {
  teamRole: string;
  userId: string | null;
  tenantId: string;
  leadId: string;
  isOwner?: boolean;
  adminAccess?: boolean;
  /**
   * `crm` preserves the shared legacy CRM rule. `owned_oasis_sales` is the
   * lead-file boundary: admins, or assigned/collaborating OASIS sales roles.
   */
  accessMode?: PerLeadAccessMode;
}): Promise<PerLeadAccess> {
  const accessMode = args.accessMode ?? "crm";
  const normalizedRole = args.teamRole.trim().toLowerCase();
  const admin =
    args.isOwner ||
    args.adminAccess ||
    normalizedRole === "owner" ||
    normalizedRole === "admin";
  if (admin) return { ok: true };
  if (accessMode === "crm" && canWriteCrm(args.teamRole)) return { ok: true };

  const db = getServiceSupabase();
  let effectiveMode = accessMode;
  if (accessMode === "owned_oasis_sales") {
    const tenantResult = await db
      .from("tenants")
      .select("slug")
      .eq("id", args.tenantId)
      .maybeSingle();
    if (tenantResult.error) {
      return {
        ok: false,
        status: 503,
        error: "tenant_lookup_failed",
        message: "Lead access could not be verified.",
      };
    }
    const tenantSlug = (tenantResult.data as { slug?: string | null } | null)?.slug ?? null;
    effectiveMode = resolvePerLeadAccessPolicy(accessMode, tenantSlug);
    if (effectiveMode === "crm" && canWriteCrm(args.teamRole)) return { ok: true };
  }

  // Not a blanket CRM writer — but this may still be their own lead, provided
  // the role is one that does sales work at all. Without this floor a
  // `read_only` account named on a deal could run write-back AI tools, which
  // is a capability it had before this branch existed.
  const roleAllowed =
    effectiveMode === "owned_oasis_sales"
      ? roleMayOperateOasisSalesLead(args.teamRole)
      : roleMaySelfEditLead(args.teamRole);
  if (!roleAllowed) {
    return {
      ok: false,
      status: 403,
      error: "forbidden_role",
      message: "Your role can't run this.",
    };
  }
  const res = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", args.tenantId)
    .eq("entity_type", "lead")
    .eq("id", args.leadId)
    .maybeSingle();

  const row = res.data as { id: string; data: Record<string, unknown> } | null;
  if (!row) {
    // Fail closed, and say "not found" rather than confirming a lead exists
    // in a tenant this caller can't read.
    return { ok: false, status: 404, error: "not_found", message: "Lead not found." };
  }

  // Ownership, not board visibility. canOpenOasisSalesRecord would also say
  // yes for the wide `member` role (the team_role column default), which is
  // the right answer for "may they look at it" and the wrong one for "may
  // they write to it".
  const mine =
    effectiveMode === "owned_oasis_sales"
      ? canMutateOasisSalesRecord(row, {
          role: args.teamRole,
          userId: args.userId,
          isOwner: args.isOwner,
          adminAccess: args.adminAccess,
        })
      : ownsOasisSalesRecord(row, args.userId);

  return mine
    ? { ok: true }
    : {
        ok: false,
        status: 403,
        error: "forbidden_role",
        message: "You can only run this on leads assigned to you.",
      };
}
