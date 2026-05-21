import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientProfileSlugForBrand, resolveClientProfileSlug } from "@/lib/client-profiles";

type ProfileRouteRow = {
  id: string;
  email: string | null;
  tenant_id: string | null;
  brand: string | null;
  primary_agent: string | null;
  is_owner: boolean | null;
  onboarding_completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type PostLoginTenantContext = {
  tenantSlug?: string | null;
  commandCenterProfileSlug?: string | null;
};

function cleanSlug(value: string | null | undefined): string | null {
  const slug = (value || "").trim().toLowerCase();
  return slug || null;
}

function safeInternalPath(raw: string | null | undefined): string {
  const value = (raw || "/").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value.startsWith("/auth/callback") || value.startsWith("/auth/land") || value.startsWith("/login")) {
    return "/";
  }
  return value || "/";
}

function tenantSlugFromPath(path: string): string | null {
  const match = path.match(/^\/t\/([a-z0-9][a-z0-9_-]{1,62})(?:\/|$)/i);
  return match ? match[1].toLowerCase() : null;
}

export function homePathForTenant(ctx: PostLoginTenantContext): string {
  const profileSlug = cleanSlug(ctx.commandCenterProfileSlug);
  if (profileSlug === "sun" || profileSlug === "suga") return `/t/${profileSlug}`;
  return "/";
}

export function normalizePostLoginRedirect(
  requestedNext: string | null | undefined,
  ctx: PostLoginTenantContext,
): string {
  const safeNext = safeInternalPath(requestedNext);
  if (safeNext.startsWith("/demo/")) return homePathForTenant(ctx);
  const requestedTenantSlug = tenantSlugFromPath(safeNext);
  if (!requestedTenantSlug) return safeNext;

  const ownSlugs = new Set(
    [ctx.tenantSlug, ctx.commandCenterProfileSlug]
      .map(cleanSlug)
      .filter((slug): slug is string => !!slug),
  );

  if (ownSlugs.has(requestedTenantSlug)) return safeNext;
  return homePathForTenant(ctx);
}

function chooseProfileForLogin(rows: ProfileRouteRow[], email: string | null | undefined): ProfileRouteRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const normalizedEmail = (email || "").trim().toLowerCase();
  const exactEmail = normalizedEmail
    ? rows.filter((row) => (row.email || "").trim().toLowerCase() === normalizedEmail)
    : [];
  const candidates = exactEmail.length > 0 ? exactEmail : rows;

  return (
    candidates.find((row) => {
      const brand = (row.brand || "").toLowerCase();
      return row.is_owner && row.primary_agent === "bravo" && brand.includes("oasis");
    }) ||
    candidates.find((row) => row.is_owner && row.onboarding_completed_at) ||
    candidates.find((row) => row.onboarding_completed_at) ||
    candidates.find((row) => row.is_owner) ||
    candidates[0]
  );
}

export async function resolvePostLoginRedirect({
  db,
  authUserId,
  email,
  requestedNext,
}: {
  db: SupabaseClient;
  authUserId: string;
  email?: string | null;
  requestedNext?: string | null;
}): Promise<string> {
  const byAuth = await db
    .from("user_profiles")
    .select("id, email, tenant_id, brand, primary_agent, is_owner, onboarding_completed_at, created_at, updated_at")
    .eq("auth_user_id", authUserId)
    .limit(20);

  let rows = ((byAuth.data || []) as ProfileRouteRow[]) || [];

  if (rows.length === 0 && email) {
    const byEmail = await db
      .from("user_profiles")
      .select("id, email, tenant_id, brand, primary_agent, is_owner, onboarding_completed_at, created_at, updated_at")
      .eq("email", email)
      .limit(20);
    rows = ((byEmail.data || []) as ProfileRouteRow[]) || [];
  }

  const profile = chooseProfileForLogin(rows, email);
  if (!profile?.tenant_id) {
    return normalizePostLoginRedirect(requestedNext, {});
  }

  const tenantRes = await db
    .from("tenants")
    .select("slug, custom_fields")
    .eq("id", profile.tenant_id)
    .maybeSingle();

  const tenant = tenantRes.data as { slug?: string | null; custom_fields?: Record<string, unknown> | null } | null;
  const profileSlug =
    resolveClientProfileSlug({
      slug: tenant?.slug || "",
      custom_fields: tenant?.custom_fields || {},
    }) || getClientProfileSlugForBrand(profile.brand, profile.email);

  return normalizePostLoginRedirect(requestedNext, {
    tenantSlug: tenant?.slug || null,
    commandCenterProfileSlug: profileSlug,
  });
}
