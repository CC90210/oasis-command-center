import "server-only";

import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { dbError } from "@/lib/db-error";
import { getManifest } from "@/lib/manifest/loader";
import { defaultAgentsForRole } from "@/lib/role-agent-defaults";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { TeamRole } from "@/lib/team";

/** Apply one canonical tenant/role agent policy after invite redemption. */
export async function finalizeInviteProfile(args: {
  tenantId: string;
  authUserId: string;
  teamRole: TeamRole;
  preserveExistingMember: boolean;
}): Promise<{ tenantSlug: string | null }> {
  const db = getServiceSupabase();
  const tenantResult = await db
    .from("tenants")
    .select("slug, custom_fields")
    .eq("id", args.tenantId)
    .maybeSingle();
  if (tenantResult.error) throw dbError("invite_profile.tenant", tenantResult.error);

  const tenantSlug = tenantResult.data
    ? resolveClientProfileSlug(tenantResult.data)
    : null;
  if (args.preserveExistingMember) return { tenantSlug };

  const manifest = await getManifest(tenantSlug);
  const defaults = defaultAgentsForRole({
    tenantSlug,
    role: args.teamRole,
    manifest,
  });
  if (defaults.length === 0) throw new Error("invite_profile_has_no_enabled_agent");

  const profileResult = await db
    .from("user_profiles")
    .update({ agents_enabled: defaults, primary_agent: defaults[0] })
    .eq("auth_user_id", args.authUserId)
    .eq("tenant_id", args.tenantId)
    .select("id")
    .maybeSingle();
  if (profileResult.error) throw dbError("invite_profile.agents", profileResult.error);
  if (!profileResult.data) throw new Error("invite_profile_not_attached");

  return { tenantSlug };
}
