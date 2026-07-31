/**
 * Shared session → tenant resolution helpers for API routes.
 *
 * Every operator-facing route needs the same flow: read the session
 * cookie, look up the user_profiles row, return the tenant_id. Before
 * this module that 6-line block was copy-pasted into ~9 routes — small
 * enough each time that it kept landing inline, big enough collectively
 * that drift (different fallback error codes, different null-handling)
 * had started to show up.
 *
 * Two entry points:
 *
 *   resolveTenantId() — Promise<string | null>. Returns null on no
 *     session, no profile, or no tenant_id. Routes that want a
 *     specific HTTP shape for the null case map it themselves.
 *
 *   resolveSessionContext() — fuller shape: { user, profileId, tenantId }
 *     or a typed null reason. Use when the route needs more than
 *     tenantId (e.g. created_by audit fields).
 */

import { getSessionUser, getServiceSupabase } from "./supabase-server";
import { chooseActiveProfile } from "./active-profile";

/**
 * Resolve the active tenant_id from the request's session cookie.
 * Returns null if there's no session, no matching user_profile, or
 * the profile carries no tenant_id (operator hasn't completed
 * onboarding).
 */
export async function resolveTenantId(): Promise<string | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const db = getServiceSupabase();
  // Same multi-profile handling as resolveSessionContext below — .maybeSingle()
  // errors on more than one row and would return null here, reading as "no
  // tenant" for a user who has one.
  const r = await db
    .from("user_profiles")
    .select("tenant_id, email, is_owner, onboarding_completed_at")
    .eq("auth_user_id", user.id)
    .limit(20);
  const rows = (r.data || []) as Array<{
    tenant_id: string | null;
    email?: string | null;
    is_owner?: boolean | null;
    onboarding_completed_at?: string | null;
  }>;
  if (!rows.length) return null;
  return chooseActiveProfile(rows, user.email)?.tenant_id ?? null;
}

/**
 * Resolve full session context for routes that need more than the
 * tenant_id — typically the user_profiles.id for `created_by` audit
 * trails or the auth user id for downstream RLS lookups.
 *
 * Returns a discriminated union so callers don't have to null-check
 * each field independently.
 */
export type SessionContext =
  | {
      ok: true;
      userId: string;
      profileId: string | null;
      tenantId: string;
      email: string | null;
      /** Team role from user_profiles. Drives per-agent lead scoping. */
      teamRole: string;
      /** owner | admin | admin_access-toggled → sees all leads / has admin
       *  CAPABILITIES; everyone else is scoped to their own. */
      isAdmin: boolean;
      /** PERMANENT admin by base role (owner / admin team_role) — EXCLUDES the
       *  admin_access toggle. Use for escalation-sensitive gates only. */
      isTrueAdmin: boolean;
      /** The admin_access toggle grant (an admin flipped this agent to full
       *  admin). Additive on top of the base role. */
      adminAccess: boolean;
    }
  | { ok: false; reason: "no_session" | "no_profile" | "no_tenant" };

export async function resolveSessionContext(): Promise<SessionContext> {
  const user = await getSessionUser();
  if (!user) return { ok: false, reason: "no_session" };
  const db = getServiceSupabase();
  // Multiple rows, then the SHARED chooser — not .maybeSingle().
  //
  // .maybeSingle() ERRORS when an auth account has more than one user_profiles
  // row, so this returned "no_profile" and every one of the ~95 routes that
  // authorize through here answered 401 — while getActiveProfile(), which
  // renders the pages those routes serve, has always supported multiple
  // profiles. A user could load a page and be refused by every write on it.
  // Both paths now resolve the active profile identically (lib/active-profile).
  const r = await db
    .from("user_profiles")
    .select("id, tenant_id, team_role, is_owner, admin_access, email, onboarding_completed_at")
    .eq("auth_user_id", user.id)
    .limit(20);
  const rows = (r.data || []) as Array<{
    id: string | null;
    tenant_id: string | null;
    team_role: string | null;
    is_owner: boolean | null;
    admin_access: boolean | null;
    email?: string | null;
    onboarding_completed_at?: string | null;
  }>;
  const profile = rows.length ? chooseActiveProfile(rows, user.email) : null;
  if (!profile) return { ok: false, reason: "no_profile" };
  if (!profile.tenant_id) return { ok: false, reason: "no_tenant" };
  // Fail-closed for authorization (Codex adversarial review round-2, 2026-07-07).
  // A missing / null / empty team_role must NOT default to a WRITE-capable role:
  // canWriteCrm() and the isReadOnly gates key off this, so defaulting to "member"
  // would silently grant a corrupt / partially-provisioned / legacy profile full
  // CRM write (assign, e-sign, promote, PDFs). Default to read_only so those
  // callers fail closed. is_owner still grants admin below regardless of this.
  // To grant write access, assign the user an explicit role — don't rely on a default.
  const teamRole = profile.team_role || "read_only";
  // PERMANENT admin by base role — the escalation-guard predicate.
  const isTrueAdmin = !!profile.is_owner || teamRole === "admin" || teamRole === "owner";
  // Additive full-admin grant: an admin toggled this agent to admin_access.
  const adminAccess = profile.admin_access === true;
  return {
    ok: true,
    userId: user.id,
    profileId: profile.id,
    tenantId: profile.tenant_id,
    email: user.email ?? null,
    teamRole,
    // Capability admin = true admin OR toggled admin_access. Folds the grant
    // into every route that keys off session.isAdmin (records, leads, campaigns,
    // shop-out, underwriting, documents, ...). Admin-toggle design 2026-07-07.
    isAdmin: isTrueAdmin || adminAccess,
    isTrueAdmin,
    adminAccess,
  };
}
