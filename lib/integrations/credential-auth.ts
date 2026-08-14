import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canManageTeam, type TeamRole } from "@/lib/team";

export async function canManageTenantIntegrations(tenantId: string, userId: string): Promise<boolean> {
  const db = getServiceSupabase();
  const result = await db.from("user_profiles").select("team_role, is_owner, admin_access").eq("auth_user_id", userId).eq("tenant_id", tenantId).maybeSingle();
  const row = result.data as { team_role: TeamRole | null; is_owner: boolean | null; admin_access: boolean | null } | null;
  return Boolean(row && (row.is_owner || canManageTeam(row.team_role || "member", row.admin_access === true)));
}
