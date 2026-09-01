import "server-only";

import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { tenantSlugFor } from "@/lib/team";

/**
 * Shared tenant resources (renewal finance, lender outreach, workspace email
 * templates) are not attributable to one rep. OASIS sales seats therefore
 * need an explicit admin capability; customer workspaces retain their legacy
 * role behavior.
 */
export function canAccessSharedTenantResourceForSlug(
  tenantSlug: string | null | undefined,
  isAdmin: boolean,
): boolean {
  if (!(tenantSlug || "").trim()) return false;
  return !isOasisSurfaceTenant(tenantSlug) || isAdmin;
}

export async function canAccessSharedTenantResource(session: {
  tenantId: string;
  isAdmin: boolean;
}): Promise<boolean> {
  if (!session.tenantId) return false;
  const tenantSlug = await tenantSlugFor(session.tenantId).catch(() => null);
  return canAccessSharedTenantResourceForSlug(tenantSlug, session.isAdmin);
}
