/**
 * Tenant-preview access gate.
 *
 * `/t/<slug>` and the `/demo/sun` redirect into `/t/sun` were rendering ANY
 * tenant's shell to ANY signed-in user — so CC logging into the OASIS portal
 * with Google could land on the SunBiz Command Center (2026-05-17 incident).
 *
 * Rule:
 *   - VERIFIED platform operators (lib/platform-operator.ts: an alias on
 *     OPERATOR_EMAIL / ADMIN_EMAILS AND an owner/admin OASIS membership read
 *     by auth id) can preview any slug.
 *   - Every other operator may only preview slugs that match their own
 *     tenant's slug or their command_center_profile_slug.
 *
 * Service-role read of the tenants row stays out of the hot path: the layout
 * already has the profile + tenant slug; this helper just compares strings.
 */
import { redirect } from "next/navigation";
import { isPlatformOperatorForAuthUser } from "./platform-operator";
import { getServiceSupabase, getSessionUser } from "./supabase-server";

export type TenantAccessProfile = {
  /**
   * The verified platform-operator verdict, computed by the caller on the
   * server (isPlatformOperatorForAuthUser / isPlatformOperator). This used to
   * be an `email` field matched against the alias list, which let anyone who
   * registered an unclaimed alias preview every tenant. Absent or false means
   * "not an operator" — the check fails closed if a caller forgets it.
   */
  isPlatformOperator?: boolean | null;
  tenant_slug?: string | null;
  command_center_profile_slug?: string | null;
};

export function canPreviewTenantSlug(
  profile: TenantAccessProfile | null | undefined,
  slug: string | null | undefined,
): boolean {
  const target = (slug || "").trim().toLowerCase();
  if (!target) return false;
  if (!profile) return false;
  if (profile.isPlatformOperator === true) return true;
  const own = (profile.tenant_slug || "").trim().toLowerCase();
  if (own && own === target) return true;
  const profileSlug = (profile.command_center_profile_slug || "").trim().toLowerCase();
  if (profileSlug && profileSlug === target) return true;
  return false;
}

/**
 * Build a TenantAccessProfile from the signed-in user. Single source of
 * truth — pages call requireTenantPreviewAccess (which uses this +
 * redirect), API routes call this directly + return their own
 * 401/404 envelope. Both layers see the same fields so the access
 * policy can't drift.
 *
 * Returns null when there's no signed-in user. Returns a partially-
 * populated profile (operator verdict only, tenant slugs null) when the
 * user has no user_profiles row yet. The operator verdict is the verified
 * check keyed on the session's auth user — never a user_profiles.email,
 * which is a column its owner can edit.
 */
export async function resolveCallerTenantAccess(): Promise<TenantAccessProfile | null> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return null;
  const isPlatformOperator = await isPlatformOperatorForAuthUser(user.id, user.email);
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = profile.data?.tenant_id || null;
  let tenantSlug: string | null = null;
  let commandSlug: string | null = null;
  if (tenantId) {
    const t = await db
      .from("tenants")
      .select("slug, custom_fields")
      .eq("id", tenantId)
      .maybeSingle();
    tenantSlug = (t.data?.slug as string | undefined) ?? null;
    const custom = (t.data?.custom_fields || {}) as Record<string, unknown>;
    const cf = custom.command_center_profile_slug;
    commandSlug = typeof cf === "string" ? cf : null;
  }
  return {
    isPlatformOperator,
    tenant_slug: tenantSlug,
    command_center_profile_slug: commandSlug,
  };
}

/**
 * Server-side gate for /t/<slug> pages and /demo/sun. Looks up the signed-in
 * operator's tenant, applies canPreviewTenantSlug, and redirects when access
 * is denied. Throws via Next's redirect() — callers don't need to handle
 * the negative case.
 */
export async function requireTenantPreviewAccess(slug: string): Promise<void> {
  const target = slug.toLowerCase();
  const access = await resolveCallerTenantAccess();
  if (!access) {
    redirect(`/login?next=${encodeURIComponent(`/t/${target}`)}`);
  }
  if (!canPreviewTenantSlug(access, target)) {
    redirect("/");
  }
}
