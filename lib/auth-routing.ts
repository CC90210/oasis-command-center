import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientProfileSlugForBrand, resolveClientProfileSlug } from "@/lib/client-profiles";
import { isOperatorEmail } from "@/lib/operator-credentials";

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
  // Empire operators (OPERATOR_EMAIL / ADMIN_EMAILS) default to the master
  // dashboard on login even when their user_profiles row resolves to a
  // client tenant — they're frequently listed as the operator on a
  // client's tenants row (e.g. CC on SunBiz), and auto-routing them
  // into /t/sun on every login was the chrome-bleed bug reported
  // 2026-05-24. They can still deep-link into any tenant via explicit
  // ?next= or by navigating manually.
  isEmpireOperator?: boolean;
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
  if (ctx.isEmpireOperator) return "/";
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

  // Empire operators can preview any tenant (per canPreviewTenantSlug),
  // so honor an explicit tenant deep-link even when the operator's own
  // profile resolves elsewhere. Without this, an operator bookmarking
  // /t/sun/leads would be silently bounced to / on every login.
  if (ctx.isEmpireOperator) return safeNext;

  const ownSlugs = new Set(
    [ctx.tenantSlug, ctx.commandCenterProfileSlug]
      .map(cleanSlug)
      .filter((slug): slug is string => !!slug),
  );

  if (ownSlugs.has(requestedTenantSlug)) return safeNext;
  return homePathForTenant(ctx);
}

/**
 * Brand-detection helpers for the empire-operator routing path. Two
 * independent checks so the chooser can pick the right tenant even
 * as new client brands are onboarded without an immediate code update.
 *
 * Reported by CC 2026-05-24; hardened 2026-05-25 to add the OASIS
 * positive-match path as the primary signal — relying ONLY on the
 * negative client-brand filter would route an operator into the
 * NEXT new client tenant the moment one is onboarded before its
 * brand pattern gets added to the deny list.
 */
const OPERATOR_HOME_BRAND_PATTERNS = [/oasis/i];
const CLIENT_BRAND_PATTERNS = [
  /^sun\s*biz/i,
  /^suga/i,
  /^propflow/i,
  /^nostalgic/i,
];

function isOperatorHomeBrand(brand: string | null): boolean {
  const s = (brand || "").trim();
  if (!s) return false;
  return OPERATOR_HOME_BRAND_PATTERNS.some((re) => re.test(s));
}

function isClientBrand(brand: string | null): boolean {
  const s = (brand || "").trim();
  if (!s) return false;
  return CLIENT_BRAND_PATTERNS.some((re) => re.test(s));
}

function chooseProfileForLogin(rows: ProfileRouteRow[], email: string | null | undefined): ProfileRouteRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const normalizedEmail = (email || "").trim().toLowerCase();
  const exactEmail = normalizedEmail
    ? rows.filter((row) => (row.email || "").trim().toLowerCase() === normalizedEmail)
    : [];
  let candidates = exactEmail.length > 0 ? exactEmail : rows;

  // Empire-operator deterministic routing — three-tier preference:
  //   1. If any candidate row's brand matches the OPERATOR home
  //      pattern (OASIS), restrict to those rows. Positive match —
  //      future-proof against new client tenants nobody added to
  //      CLIENT_BRAND_PATTERNS yet.
  //   2. Else if any candidate is a non-client brand, drop the
  //      known-client rows. Catches operators with a non-OASIS home
  //      tenant we haven't anticipated.
  //   3. Else (operator's only profile rows are all clients) — leave
  //      candidates intact and let the find chain pick its best.
  //
  // Non-operators get the full row set unchanged.
  if (isOperatorEmail(email || undefined)) {
    const operatorHome = candidates.filter((row) => isOperatorHomeBrand(row.brand));
    if (operatorHome.length > 0) {
      candidates = operatorHome;
    } else {
      const nonClient = candidates.filter((row) => !isClientBrand(row.brand));
      if (nonClient.length > 0) candidates = nonClient;
    }
  }

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

async function fetchProfileRows(
  db: SupabaseClient,
  authUserId: string,
  email?: string | null,
): Promise<ProfileRouteRow[]> {
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
  return rows;
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
  let rows = await fetchProfileRows(db, authUserId, email);

  // Provisioning race recovery (2026-05-24): when a brand-new OAuth
  // signup hits this resolver, provisionAuthenticatedUser() may have
  // just committed and the read replica hasn't caught up yet. A 0-row
  // result here used to silently fall back to "/" → marketing landing.
  // One short retry covers the common read-after-write lag without
  // adding meaningful latency to every login.
  if (rows.length === 0) {
    await new Promise((r) => setTimeout(r, 250));
    rows = await fetchProfileRows(db, authUserId, email);
  }

  const profile = chooseProfileForLogin(rows, email);
  if (!profile?.tenant_id) {
    // Still no profile after retry — send the user to the new-user
    // wizard instead of dumping them at "/" where the dashboard can't
    // render anything useful. The wizard is idempotent and re-runs
    // provisioning, so the next dashboard hit will work.
    return "/onboarding/welcome";
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
    isEmpireOperator: isOperatorEmail(email || profile.email || undefined),
  });
}
