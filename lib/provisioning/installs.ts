/**
 * lib/provisioning/installs.ts - every workspace, as the operator's install
 * console lists it. Operator-only by its callers (app/admin/installs,
 * app/api/admin/installs); this module reads across workspaces on purpose and
 * must never be imported by a tenant-scoped surface.
 *
 * "Last activity" is the newest of: a profile change, a manifest save, an audit
 * event, a provisioning step. It says when something last CHANGED in the
 * workspace, not when someone last looked at it (sign-ins are not recorded per
 * workspace).
 */

import "server-only";

import { OASIS_SEED_TENANT_IDS } from "@/lib/manifest/seeds";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { getTursoClient } from "@/lib/turso";

export type InstallRow = {
  tenantId: string;
  slug: string;
  name: string;
  createdAt: string | null;
  kind: "client" | "oasis" | "retired";
  ownerEmail: string | null;
  ownerName: string | null;
  members: number;
  /** The slug the workspace's manifest is saved under, or null (not set up). */
  manifestSlug: string | null;
  runStatus: string | null;
  lastActivity: string | null;
  /** Email of an open owner invite, if one is waiting. */
  pendingOwnerInvite: string | null;
};

function maxIso(...values: unknown[]): string | null {
  const iso = values.filter((v): v is string => typeof v === "string" && v.trim() !== "").sort();
  return iso.length ? iso[iso.length - 1] : null;
}

/** Throws on a failed read: the console says "could not load", never "no workspaces". */
export async function listInstalls(): Promise<InstallRow[]> {
  const now = new Date().toISOString();
  const rs = await getTursoClient().execute({
    sql: `SELECT t.id, t.slug, t.name, t.created_at, t.updated_at,
                 (SELECT COUNT(*) FROM user_profiles p WHERE p.tenant_id = t.id AND p.deactivated_at IS NULL) AS members,
                 (SELECT p.email FROM user_profiles p WHERE p.tenant_id = t.id AND p.is_owner = 1 LIMIT 1) AS owner_email,
                 (SELECT p.full_name FROM user_profiles p WHERE p.tenant_id = t.id AND p.is_owner = 1 LIMIT 1) AS owner_name,
                 (SELECT m.slug FROM tenant_manifests m WHERE m.tenant_id = t.id LIMIT 1) AS manifest_slug,
                 (SELECT m.updated_at FROM tenant_manifests m WHERE m.tenant_id = t.id LIMIT 1) AS manifest_at,
                 (SELECT MAX(p.updated_at) FROM user_profiles p WHERE p.tenant_id = t.id) AS profile_at,
                 (SELECT MAX(a.created_at) FROM tenant_audit_log a WHERE a.tenant_id = t.id) AS audit_at,
                 (SELECT r.status FROM provisioning_runs r WHERE r.tenant_id = t.id
                   ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 1) AS run_status,
                 (SELECT COALESCE(r.completed_at, r.started_at) FROM provisioning_runs r WHERE r.tenant_id = t.id
                   ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 1) AS run_at,
                 (SELECT i.email FROM tenant_invites i
                   WHERE i.tenant_id = t.id AND i.team_role = 'owner' AND i.redeemed_at IS NULL
                     AND i.revoked_at IS NULL AND i.expires_at > ?
                   ORDER BY i.created_at DESC LIMIT 1) AS pending_owner_invite
            FROM tenants t
           ORDER BY t.created_at DESC`,
    args: [now],
  });
  return rs.rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    const tenantId = String(r.id);
    const kind: InstallRow["kind"] = OASIS_SEED_TENANT_IDS.has(tenantId)
      ? "oasis"
      : isRetiredTenant(tenantId)
        ? "retired"
        : "client";
    return {
      tenantId,
      slug: String(r.slug ?? ""),
      name: String(r.name ?? ""),
      createdAt: r.created_at == null ? null : String(r.created_at),
      kind,
      ownerEmail: r.owner_email == null ? null : String(r.owner_email),
      ownerName: r.owner_name == null ? null : String(r.owner_name),
      members: Number(r.members ?? 0),
      manifestSlug: r.manifest_slug == null ? null : String(r.manifest_slug),
      runStatus: r.run_status == null ? null : String(r.run_status),
      lastActivity: maxIso(r.profile_at, r.manifest_at, r.audit_at, r.run_at),
      pendingOwnerInvite: r.pending_owner_invite == null ? null : String(r.pending_owner_invite),
    };
  });
}
