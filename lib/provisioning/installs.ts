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
 *
 * Two additions (2026-09-30 fix pass):
 *   currentSetup         what the stored setup says (departments, add-ons, chat
 *                        apps, Jev), so "Set up again" starts from the
 *                        workspace's own choices instead of the defaults.
 *   pendingOwnerInvites  EVERY open owner invite, not just the newest, so an
 *                        invite to a mistyped address is visible and revocable.
 */

import "server-only";

import { OASIS_SEED_TENANT_IDS } from "@/lib/manifest/seeds";
import { parseManifest, type ManifestChatApp, type ManifestJevMode } from "@/lib/manifest/schema";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { getTursoClient } from "@/lib/turso";

/**
 * The stored setup's choices. `departments` is null when the setup was saved
 * before departments were recorded (manifest.os absent): the console then says
 * so instead of pretending the defaults were chosen.
 */
export type CurrentSetup = {
  departments: string[] | null;
  modules: string[];
  chatApps: ManifestChatApp[];
  jev: ManifestJevMode;
  /** Teammate display names in the stored setup. */
  teammates: string[];
};

export type PendingOwnerInvite = { id: string; email: string; createdAt: string | null; expiresAt: string | null };

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
  /** The stored setup; "unreadable" when the manifest is stored but does not parse. */
  currentSetup: CurrentSetup | "unreadable" | null;
  runStatus: string | null;
  lastActivity: string | null;
  /** Every open owner invite, newest first. */
  pendingOwnerInvites: PendingOwnerInvite[];
};

function maxIso(...values: unknown[]): string | null {
  const iso = values.filter((v): v is string => typeof v === "string" && v.trim() !== "").sort();
  return iso.length ? iso[iso.length - 1] : null;
}

/**
 * The stored manifest's setup choices. A manifest that does not parse is
 * reported as "unreadable" (and logged): provisioning refuses to replace such a
 * setup, so the console must not offer defaults as if it were empty.
 */
export function currentSetupOf(raw: unknown, tenantId: string): CurrentSetup | "unreadable" | null {
  if (raw == null) return null;
  try {
    const m = parseManifest(typeof raw === "string" ? JSON.parse(raw) : raw);
    return {
      departments: m.os ? [...m.os.departments] : null,
      modules: m.os ? [...m.os.modules] : [],
      chatApps: [...(m.integrations?.chat_apps ?? [])],
      jev: m.integrations?.jev ?? "off",
      teammates: m.agents.map((a) => a.display_name),
    };
  } catch (err) {
    console.error("[installs] stored setup does not parse", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unreadable";
  }
}

/** Throws on a failed read: the console says "could not load", never "no workspaces". */
export async function listInstalls(): Promise<InstallRow[]> {
  const now = new Date().toISOString();
  const client = getTursoClient();
  const rs = await client.execute({
    sql: `SELECT t.id, t.slug, t.name, t.created_at, t.updated_at,
                 (SELECT COUNT(*) FROM user_profiles p WHERE p.tenant_id = t.id AND p.deactivated_at IS NULL) AS members,
                 (SELECT p.email FROM user_profiles p WHERE p.tenant_id = t.id AND p.is_owner = 1 LIMIT 1) AS owner_email,
                 (SELECT p.full_name FROM user_profiles p WHERE p.tenant_id = t.id AND p.is_owner = 1 LIMIT 1) AS owner_name,
                 (SELECT m.slug FROM tenant_manifests m WHERE m.tenant_id = t.id LIMIT 1) AS manifest_slug,
                 (SELECT m.manifest FROM tenant_manifests m WHERE m.tenant_id = t.id LIMIT 1) AS manifest_json,
                 (SELECT m.updated_at FROM tenant_manifests m WHERE m.tenant_id = t.id LIMIT 1) AS manifest_at,
                 (SELECT MAX(p.updated_at) FROM user_profiles p WHERE p.tenant_id = t.id) AS profile_at,
                 (SELECT MAX(a.created_at) FROM tenant_audit_log a WHERE a.tenant_id = t.id) AS audit_at,
                 (SELECT r.status FROM provisioning_runs r WHERE r.tenant_id = t.id
                   ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 1) AS run_status,
                 (SELECT COALESCE(r.completed_at, r.started_at) FROM provisioning_runs r WHERE r.tenant_id = t.id
                   ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 1) AS run_at
            FROM tenants t
           ORDER BY t.created_at DESC`,
    args: [],
  });
  // Every open owner invite (an owner_claim invite always has team_role
  // 'owner'; a hand-inserted member invite that says 'owner' is listed too, so
  // it can be revoked).
  const invites = await client.execute({
    sql: `SELECT i.id, i.tenant_id, i.email, i.created_at, i.expires_at
            FROM tenant_invites i
           WHERE i.team_role = 'owner' AND i.redeemed_at IS NULL
             AND i.revoked_at IS NULL AND i.expires_at > ?
           ORDER BY i.created_at DESC`,
    args: [now],
  });
  const invitesByTenant = new Map<string, PendingOwnerInvite[]>();
  for (const raw of invites.rows) {
    const r = raw as Record<string, unknown>;
    const tenantId = String(r.tenant_id);
    const list = invitesByTenant.get(tenantId) ?? [];
    list.push({
      id: String(r.id),
      email: String(r.email ?? ""),
      createdAt: r.created_at == null ? null : String(r.created_at),
      expiresAt: r.expires_at == null ? null : String(r.expires_at),
    });
    invitesByTenant.set(tenantId, list);
  }
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
      currentSetup: currentSetupOf(r.manifest_json, tenantId),
      runStatus: r.run_status == null ? null : String(r.run_status),
      lastActivity: maxIso(r.profile_at, r.manifest_at, r.audit_at, r.run_at),
      pendingOwnerInvites: invitesByTenant.get(tenantId) ?? [],
    };
  });
}
