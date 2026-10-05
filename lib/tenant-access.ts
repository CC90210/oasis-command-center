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
import { notFound, redirect } from "next/navigation";
import { resolveSessionContext } from "./api-auth";
import { ownsSlugOrThrow } from "./manifest/tenant-scope";
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

/**
 * Server-side gate for the /t/<slug> pages that show ONE workspace's agents
 * or manifest (marketplace, marketplace/<agent>, marketplace/new, editor): the
 * session's active workspace must own the slug (ownsSlug, the records API's
 * own rule), or the viewer is a verified platform operator. Anyone else gets
 * the 404 a missing workspace gets, so the answer confirms nothing about the
 * workspace behind the slug.
 *
 * Those pages checked only manifestExists, and middleware only checks for a
 * session, so any signed-in user could read another workspace's enabled
 * agents, their display names and prompt overlays, its private agents' prompts
 * and its whole manifest (W1a security finding).
 *
 * An outage is an error, never a quiet 404: a failed profile read throws
 * (resolveSessionContext), and so does a failed manifest-row or tenants read
 * (ownsSlugOrThrow; ownsSlug would answer it "not yours"), logged here first.
 *
 * Answers which way the viewer got in: "own" (the session's workspace owns the
 * slug) or "operator" (a verified operator looking at another workspace). A
 * page that hands off to an OS route reading only the session's workspace
 * moves an "own" viewer only.
 */
export async function requireOwnedTenantSlug(slug: string): Promise<"own" | "operator"> {
  const target = slug.trim().toLowerCase();
  const session = await resolveSessionContext();
  if (!session.ok) notFound();
  let own: boolean;
  try {
    own = await ownsSlugOrThrow(target, session.tenantId);
  } catch (err) {
    console.error("[tenant-access.owned_slug]", { slug: target, tenant_id: session.tenantId }, err);
    throw err;
  }
  if (own) return "own";
  if (await isPlatformOperatorForAuthUser(session.userId, session.email)) return "operator";
  notFound();
}
