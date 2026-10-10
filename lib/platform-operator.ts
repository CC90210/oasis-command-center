/**
 * platform-operator — the ONE verified answer to "is this auth user a platform
 * operator?" (P0-7 interim, 2026-09-28).
 *
 * isOperatorEmail (lib/operator-credentials.ts) alone trusts an email string,
 * and signup issues a session to any address with no proof of ownership. Any
 * alias in OPERATOR_EMAIL / ADMIN_EMAILS with no live auth user could be
 * registered by a stranger, who then held operator powers on every tenant: the
 * shell/file bridge, the /t/<slug> preview of every workspace, the empire-wide
 * event feed, the platform API keys, the Empire cron lane. Every call site that
 * GRANTS power asks this module instead; tests/operator-check-migrated.test.ts
 * fails the build if a new one reaches for the bare email check.
 *
 * WHY ITS OWN MODULE and not lib/role-surfaces-session.ts, which fronts it for
 * pages (resolvePlatformOperator / isPlatformOperator / requireOperator): that
 * file imports next/navigation for its 404 guards, and the callers here include
 * route handlers, lib/bridge-proxy.ts and lib/auth-routing.ts, which have no
 * business loading the page router — nor can they under the react-server test
 * runner, where next/navigation does not load at all. This file imports only
 * what the rule itself needs.
 */

import { chooseActiveProfile, type ActiveUserProfile } from "@/lib/active-profile-resolver";
import { dbBool } from "@/lib/db-bool";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { resolvePersona } from "@/lib/role-surfaces";
import { getServiceSupabase } from "@/lib/supabase-server";

/**
 * The OASIS home tenant (slug `oasis-ai-cc`). A platform operator is a founder
 * HERE — not merely someone whose email is on a list.
 *
 * Declared rather than imported from lib/web-leads/tenant.ts (WEBDEV_TENANT_ID
 * holds the same uuid today): that constant has been repointed once already, to
 * move the web-design leads, and a lead-routing change must never silently move
 * who holds operator powers across every tenant.
 */
export const OASIS_OPERATOR_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

/**
 * The durable P0-7 half (2026-10-10): a founder whose email is not an alias is
 * an operator when his AUTH USER ID is listed in platform_operators
 * (database/turso/bravo__208_platform_operators.sql) and not revoked. Adon, an
 * equal owner of OASIS, held an admin seat but no alias, so he had no operator
 * console at all; adding him to a Worker secret meant a deploy-side change for
 * every new founder, and an email list is the squattable shape this module
 * exists to retire.
 *
 * Only an account on this domain is ever looked up. That is a COST rule, not a
 * trust rule: the root layout asks this question on every page, and every
 * client member must keep paying zero reads for it. Anyone can register an
 * address here, so the grant itself still needs the listed auth id AND the
 * founder seat below; a stranger on this domain costs one read and gets no.
 */
const LISTED_OPERATOR_EMAIL_DOMAIN = "@oasisai.work";

function mayBeListedOperator(email: string | null | undefined): boolean {
  return String(email || "").trim().toLowerCase().endsWith(LISTED_OPERATOR_EMAIL_DOMAIN);
}

/** Is this auth user listed (and not revoked) in platform_operators? Fails CLOSED. */
async function readListedOperator(authUserId: string): Promise<boolean | "error"> {
  try {
    const { data, error } = await getServiceSupabase()
      .from("platform_operators")
      .select("auth_user_id, revoked_at")
      .eq("auth_user_id", authUserId)
      .limit(1);
    if (error) throw new Error(error.message);
    const row = ((data || []) as Array<{ auth_user_id?: string | null; revoked_at?: string | null }>)[0];
    return Boolean(row && row.auth_user_id === authUserId && !row.revoked_at);
  } catch (err) {
    console.error("[role-surfaces.platform_operator.listed]", err);
    return "error";
  }
}

export type PlatformOperatorCheck =
  | { operator: true; userId: string }
  | {
      operator: false;
      reason: "no_session" | "not_operator_email" | "not_oasis_founder" | "lookup_failed";
    };

type OperatorProfileRow = ActiveUserProfile & { deactivated_at?: string | null };

/**
 * Is this AUTH USER a platform operator? For callers that already hold the
 * auth user (a route that read its own session, a helper handed the ids);
 * lib/role-surfaces-session.ts resolvePlatformOperator is this plus the
 * session read.
 *
 * Pass the auth user's id and the auth user's own (session) email. NEVER a
 * user_profiles.email: that is a column, and "set my profile email to an alias"
 * is the same squat as registering one.
 *
 * Both must hold:
 *   1. the email is an operator alias (isOperatorEmail), OR that auth user id
 *      is listed, unrevoked, in platform_operators (read only for an account on
 *      LISTED_OPERATOR_EMAIL_DOMAIN, and only after 2 holds), and
 *   2. that auth user id is an active owner/admin member of the OASIS tenant.
 *
 * A stranger who registers an alias gets their OWN new tenant, never an
 * owner/admin row in OASIS's, so (2) closes the squat without a migration. The
 * durable fix is a platform_operators table keyed by auth id (doc 02 P0-7).
 *
 * Membership is read by auth_user_id ONLY. The email fallback in
 * resolveActiveProfileForUser is exactly the path an alias squatter would ride,
 * so it is not used here, and neither is the viewer's ACTIVE profile — CC stays
 * an operator while standing in another workspace.
 *
 * "Owner/admin" is resolvePersona's founder rule with the admin_access toggle
 * forced off: that toggle hands someone the full screen of ONE workspace and
 * explicitly confers no escalation powers, and operator is the biggest one.
 * Duplicate OASIS rows resolve through chooseActiveProfile, the same canonical
 * pick every session makes, so a stale admin duplicate cannot elevate a
 * current non-admin row; a deactivated canonical row is refused.
 *
 * Fails CLOSED: a profile lookup error is logged and answers "not an operator".
 */
export async function resolvePlatformOperatorForAuthUser(
  authUserId: string | null | undefined,
  email: string | null | undefined,
): Promise<PlatformOperatorCheck> {
  if (!authUserId) return { operator: false, reason: "no_session" };
  // Cheap check first: a session that is neither an alias nor on the listed
  // operators' domain never costs a database read, which is every client
  // member on every gated request.
  const alias = isOperatorEmail(email);
  if (!alias && !mayBeListedOperator(email)) return { operator: false, reason: "not_operator_email" };
  // A non-alias is refused for the same reason whatever stops it below: it was
  // never on the list, and a founder seat alone confers nothing.
  const notFounder = alias ? "not_oasis_founder" : "not_operator_email";

  let rows: OperatorProfileRow[];
  try {
    const { data, error } = await getServiceSupabase()
      .from("user_profiles")
      .select("id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, updated_at, deactivated_at")
      .eq("auth_user_id", authUserId)
      .eq("tenant_id", OASIS_OPERATOR_TENANT_ID)
      .limit(20);
    if (error) throw new Error(error.message);
    rows = (data || []) as OperatorProfileRow[];
  } catch (err) {
    console.error("[role-surfaces.platform_operator.membership]", err);
    return { operator: false, reason: "lookup_failed" };
  }
  if (rows.length === 0) return { operator: false, reason: notFounder };

  const profile = chooseActiveProfile(rows, email) as OperatorProfileRow;
  const founder =
    !profile.deactivated_at &&
    resolvePersona({
      teamRole: profile.team_role,
      // dbBool (lib/db-bool.ts): true, 1 and "1" count; a stringly "0" cannot.
      isTrueAdmin: dbBool(profile.is_owner),
      adminAccess: false,
    }) === "founder";
  if (!founder) return { operator: false, reason: notFounder };
  if (alias) return { operator: true, userId: authUserId };

  // A founder without an alias: listed by auth id, never by email.
  const listed = await readListedOperator(authUserId);
  if (listed === "error") return { operator: false, reason: "lookup_failed" };
  return listed
    ? { operator: true, userId: authUserId }
    : { operator: false, reason: "not_operator_email" };
}

/** Boolean form of resolvePlatformOperatorForAuthUser, for callers that only branch. */
export async function isPlatformOperatorForAuthUser(
  authUserId: string | null | undefined,
  email: string | null | undefined,
): Promise<boolean> {
  return (await resolvePlatformOperatorForAuthUser(authUserId, email)).operator;
}
