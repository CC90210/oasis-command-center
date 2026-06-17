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
  // A bare-root next ("/" — the default whenever there's no explicit ?next=,
  // and what safeInternalPath collapses login-loop / auth-callback values to)
  // means "no specific destination". Route the user to their resolved home so
  // a SunBiz/suga MEMBER lands on their tenant DASHBOARD (/t/sun) deterministically
  // rather than bouncing through "/" → app/page.tsx. Empire operators + every
  // other tenant still resolve to "/" via homePathForTenant. (CC 2026-06-17:
  // fresh SunBiz sessions were surfacing the chat-first /reasoning view; the
  // dashboard must be the landing.)
  if (safeNext === "/") return homePathForTenant(ctx);
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

/**
 * Orphan-recovery hook (2026-05-29).
 *
 * Detects the silent-signup-failure case: a signed-in auth user with no
 * user_profiles.tenant_id and an active tenant_invite pinned to their
 * email. This happens when /api/auth/finalize-invite-signup encounters
 * a transient error during the redeem step but the auth.users row was
 * already created. Today's symptom: every subsequent /api/* call returns
 * 401 "unauthorized" because getSessionContext() returns null without a
 * tenant attachment. The user thinks signin is broken.
 *
 * Resolution: when we detect the orphan state, look up an active invite
 * pinned to the user's email and atomically redeem it via the SECURITY
 * DEFINER RPC. The RPC creates the user_profiles row + sets tenant_id +
 * marks the invite redeemed. Caller can then re-fetch the profile row.
 *
 * Returns true if an orphan was recovered, false otherwise.
 */
async function tryRecoverOrphanInvite(
  db: SupabaseClient,
  authUserId: string,
  email: string | null | undefined,
): Promise<boolean> {
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  // Find any active invite pinned to this email. If there's more than
  // one (very rare — multi-tenant invite cascade) we pick the most
  // recently created. Older ones can still be redeemed manually after
  // the user is in a working state.
  const { data: invites } = await db
    .from("tenant_invites")
    .select("token_hash, created_at")
    .eq("email", normalizedEmail)
    .is("redeemed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  const invite = (invites || [])[0] as { token_hash?: string | null } | undefined;
  if (!invite?.token_hash) {
    // Quiet path — orphan with no invite means a genuinely new user landed
    // in the resolver before provisioning ran. The wizard fallthrough will
    // route them correctly; no operational signal needed.
    return false;
  }

  // The RPC takes a token HASH (not the raw token). The hash is what we
  // already have in the row — no need to round-trip through the raw
  // token, which only the original recipient holds. The SECURITY
  // DEFINER function still enforces email_pinned vs auth.users.email
  // so we can't accidentally redeem onto a wrong user.
  const { data, error } = await db.rpc("redeem_tenant_invite", {
    p_token_hash: invite.token_hash,
    p_redeemer_auth_id: authUserId,
  });
  if (error || !data?.ok) {
    // Structured server log so ops can see when recovery WAS attempted
    // but the RPC rejected (email_mismatch, expired between read+rpc,
    // etc). Silent failure of recovery is the worst outcome — same as
    // before the fix — so make it visible. Use console.warn over .error
    // because the user gracefully falls through to /onboarding/welcome.
    console.warn("[auth-routing] orphan-recovery RPC failed", {
      auth_user_id: authUserId,
      email: normalizedEmail,
      rpc_error: error?.message || data?.error || "unknown",
    });
    return false;
  }
  // Successful recovery is the load-bearing telemetry signal — log it
  // at info level so ops can confirm the fix is firing in production.
  console.info("[auth-routing] orphan-recovery succeeded", {
    auth_user_id: authUserId,
    email: normalizedEmail,
    tenant_id: data?.tenant_id,
    team_role: data?.team_role,
  });
  return true;
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

  let profile = chooseProfileForLogin(rows, email);

  // Orphan recovery (2026-05-29): if there's still no tenant attachment
  // after the provisioning-race retry, check for an active invite pinned
  // to this email and auto-redeem. Closes the silent-signup-failure
  // window that left jordan@/alex@sunbizfunding.com with auth accounts
  // but no profile, surfacing as "unauthorized" on every API call.
  if (!profile?.tenant_id) {
    const recovered = await tryRecoverOrphanInvite(db, authUserId, email);
    if (recovered) {
      rows = await fetchProfileRows(db, authUserId, email);
      profile = chooseProfileForLogin(rows, email);
    }
  }

  if (!profile?.tenant_id) {
    // Still no profile after retry + invite-recovery — send the user
    // to the new-user wizard instead of dumping them at "/" where the
    // dashboard can't render anything useful. The wizard is idempotent
    // and re-runs provisioning, so the next dashboard hit will work.
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
