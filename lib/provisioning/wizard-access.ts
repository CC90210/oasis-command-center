/**
 * Who may run the onboarding wizard (2026-09-30, audit finding
 * wizard-member-becomes-owner): the owner of their own workspace
 * (user_profiles.is_owner = 1) or a verified platform operator. The page
 * (app/onboarding/wizard/page.tsx) and the API (app/api/onboarding/wizard)
 * gate with this one function so they cannot disagree.
 *
 * A read failure refuses (503); it is never read as permission.
 */

import "server-only";

import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { getServiceSupabase } from "@/lib/supabase-server";
import { dbBool } from "@/lib/db-bool";

export type WizardCaller = { id: string; tenant_id: string; team_role: string; is_owner: unknown };

export type WizardAccess =
  | { ok: true; profile: WizardCaller; operator: boolean }
  | { ok: false; status: number; error: string; reason: string };

export async function wizardAccess(user: { id: string; email?: string | null }): Promise<WizardAccess> {
  const profileQuery = await getServiceSupabase()
    .from("user_profiles")
    .select("id, tenant_id, team_role, is_owner")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileQuery.error) {
    console.error("[wizard-access] profile read failed", profileQuery.error.message);
    return { ok: false, status: 503, error: "profile_unreadable", reason: "Could not read your profile. Try again." };
  }
  const profile = profileQuery.data as (Omit<WizardCaller, "tenant_id"> & { tenant_id: string | null }) | null;
  if (!profile?.tenant_id) {
    return { ok: false, status: 403, error: "no_tenant", reason: "Your account is not linked to a workspace yet." };
  }
  // dbBool (lib/db-bool.ts): Number() also read " 1", "1.0" and "0x1" as yes.
  const owner = dbBool(profile.is_owner);
  const operator = owner ? false : (await resolvePlatformOperatorForAuthUser(user.id, user.email ?? null)).operator;
  if (!owner && !operator) {
    return {
      ok: false,
      status: 403,
      error: "owner_required",
      reason: "Only the workspace owner can set up this workspace. Ask your owner, or OASIS, to do it.",
    };
  }
  return { ok: true, profile: { ...profile, tenant_id: profile.tenant_id }, operator };
}
