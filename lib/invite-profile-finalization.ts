import "server-only";

import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { dbError } from "@/lib/db-error";
import { getManifestByTenantId } from "@/lib/manifest/loader";
import { getSeedManifest, isUnprovisionedManifest } from "@/lib/manifest/seeds";
import type { TenantManifest } from "@/lib/manifest/schema";
import { defaultAgentsForRole } from "@/lib/role-agent-defaults";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { TeamRole } from "@/lib/team-roles";

type ServiceDb = Pick<ReturnType<typeof getServiceSupabase>, "from">;

/**
 * What a member's profile looks like the moment they join a workspace: which
 * agents they get, their primary agent, and the workspace name stamped on the
 * profile. Decided BEFORE the invite is claimed; lib/turso-rpc-shim.ts
 * redeem_tenant_invite writes these values in the SAME batch as the claim.
 */
export type InviteProfilePlan = {
  tenantSlug: string | null;
  tenantName: string | null;
  /** May be empty: a workspace OASIS has not set up yet has no teammates. */
  agentsEnabled: string[];
  /** "" when agentsEnabled is empty (the column is NOT NULL). */
  primaryAgent: string;
  /** user_profiles.brand for the joining member: the workspace's own name. */
  brand: string | null;
};

/**
 * The workspace's manifest for agent defaults, by TENANT ID first.
 *
 * WHY BY TENANT ID (2026-09-30). This used to be getManifest(workspace slug).
 * The onboarding wizard saves a manifest under the slug the owner typed, so a
 * provisioned client workspace looked unprovisioned here, and since 5c374a19
 * an unprovisioned workspace has no agents, so finalization threw
 * invite_profile_has_no_enabled_agent AFTER the invite was already claimed.
 * The in-code seeds (OASIS's own workspaces, which have no stored row) are the
 * fallback, and only when they are a real seed, never the placeholder.
 */
async function manifestForTenant(
  db: ServiceDb,
  tenantId: string,
  tenantSlug: string | null,
): Promise<TenantManifest | null> {
  const stored = await getManifestByTenantId(tenantId, db);
  if (stored) return stored;
  const seed = getSeedManifest(tenantSlug, tenantId);
  return isUnprovisionedManifest(seed) ? null : seed;
}

/**
 * Decide the joining member's profile. Throws only when the workspace cannot
 * be read (a failed read, or a workspace that does not exist): redemption then
 * refuses BEFORE claiming, so the invite stays usable for a retry.
 *
 * A workspace with no teammates yet (not provisioned) is NOT an error: the
 * member joins with no agents, and gets them when OASIS provisions the
 * workspace (lib/provisioning/provision-tenant.ts backfills empty rosters).
 */
export async function finalizeInviteProfile(args: {
  tenantId: string;
  teamRole: TeamRole;
  /** Injectable for the caller that already holds a client (lib/auth-routing.ts). */
  db?: ServiceDb;
}): Promise<InviteProfilePlan> {
  const db = args.db ?? getServiceSupabase();
  const tenantResult = await db
    .from("tenants")
    .select("slug, name, custom_fields")
    .eq("id", args.tenantId)
    .maybeSingle();
  if (tenantResult.error) throw dbError("invite_profile.tenant", tenantResult.error);
  if (!tenantResult.data) throw new Error("invite_tenant_not_found");

  const tenant = tenantResult.data as { slug: string | null; name: string | null; custom_fields: unknown };
  const tenantSlug = resolveClientProfileSlug({
    slug: tenant.slug || "",
    custom_fields: (tenant.custom_fields || {}) as Record<string, unknown>,
  });
  const manifest = await manifestForTenant(db, args.tenantId, tenantSlug);
  const agentsEnabled = defaultAgentsForRole({ tenantSlug, role: args.teamRole, manifest });
  const tenantName = (tenant.name || "").trim() || null;
  return {
    tenantSlug,
    tenantName,
    agentsEnabled,
    primaryAgent: agentsEnabled[0] ?? "",
    brand: tenantName,
  };
}

/** The joining member's landing slug for a redemption that was already done. */
export async function inviteTenantSlug(tenantId: string): Promise<string | null> {
  const { data, error } = await getServiceSupabase()
    .from("tenants")
    .select("slug, custom_fields")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw dbError("invite_profile.tenant_slug", error);
  if (!data) return null;
  const row = data as { slug: string | null; custom_fields: unknown };
  return resolveClientProfileSlug({
    slug: row.slug || "",
    custom_fields: (row.custom_fields || {}) as Record<string, unknown>,
  });
}
