/**
 * lib/onboarding-claim.ts - the onboarding gate's decision, computed where the
 * database is (Node routes) and carried to the edge in the session cookie.
 *
 * WHY. middleware.ts ran the onboarding gate only in its Supabase branch. The
 * Turso branch (production) verified the cookie and let every page through, so
 * a workspace owner whose workspace was not set up, or an invitee whose join
 * failed, landed on screens that could not work for them. Middleware cannot
 * query Turso at the edge, so each route that mints or changes a session
 * (login, signup, invite redemption, finishing the wizard) stamps the gate's
 * answer into the signed cookie, and middleware reads it with no database call.
 *
 * The claim is a ROUTING HINT, never an authorization. A stale claim can only
 * send someone to an onboarding page, and those pages re-check the database and
 * refresh the claim (app/api/auth/onboarding-refresh) when it is out of date.
 */

import type { Client } from "@libsql/client";
import type { NextResponse } from "next/server";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getSeedManifest, isUnprovisionedManifest } from "@/lib/manifest/seeds";
import {
  claimForDestination,
  shouldRedirectToOnboarding,
  type OnboardingClaim,
} from "@/lib/onboarding-gate";
import { SESSION_COOKIE, signSession, type TursoSession } from "@/lib/turso-auth";

export type OnboardingState = {
  claim: OnboardingClaim;
  tenantId: string | null;
  /** null when the viewer has no workspace. */
  workspaceProvisioned: boolean | null;
};

function parseCustomFields(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  // A malformed column throws here and the caller logs it: an unreadable
  // workspace row is "could not tell", never "not provisioned".
  if (typeof raw === "string" && raw.trim().startsWith("{")) return JSON.parse(raw) as Record<string, unknown>;
  return {};
}

/**
 * The gate's answer for one auth user, read straight from the database.
 * Throws on a failed read: the caller decides (login mints no claim, which
 * the gate reads as "do not redirect").
 *
 * "Provisioned" is the same test the shell uses: the workspace has its own
 * manifest row, or it is one of the workspaces defined in code (OASIS's own).
 */
export async function computeOnboardingState(
  client: Pick<Client, "execute">,
  authUserId: string,
): Promise<OnboardingState> {
  const rs = await client.execute({
    sql: `SELECT p.onboarding_completed_at, p.invited_by, p.tenant_id, p.is_owner,
                 t.slug AS tenant_slug, t.custom_fields AS tenant_custom_fields,
                 (SELECT 1 FROM tenant_manifests m WHERE m.tenant_id = p.tenant_id LIMIT 1) AS has_manifest
            FROM user_profiles p
            LEFT JOIN tenants t ON t.id = p.tenant_id
           WHERE p.auth_user_id = ?
           LIMIT 1`,
    args: [authUserId],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { claim: "done", tenantId: null, workspaceProvisioned: null };

  const tenantId = row.tenant_id == null ? null : String(row.tenant_id);
  let workspaceProvisioned: boolean | null = null;
  if (tenantId) {
    const slug = resolveClientProfileSlug({
      slug: row.tenant_slug == null ? "" : String(row.tenant_slug),
      custom_fields: parseCustomFields(row.tenant_custom_fields),
    });
    workspaceProvisioned =
      Number(row.has_manifest ?? 0) === 1 || !isUnprovisionedManifest(getSeedManifest(slug, tenantId));
  }
  const destination = shouldRedirectToOnboarding(
    {
      onboarding_completed_at: row.onboarding_completed_at == null ? null : String(row.onboarding_completed_at),
      invited_by: row.invited_by == null ? null : String(row.invited_by),
      tenant_id: tenantId,
      is_owner: row.is_owner == null ? null : Number(row.is_owner),
    },
    { workspaceProvisioned },
  );
  return { claim: claimForDestination(destination), tenantId, workspaceProvisioned };
}

/**
 * The claim for a session about to be minted, or undefined when it could not
 * be computed. Undefined is safe: the gate never redirects a cookie without a
 * claim. Logged, so a broken read is visible rather than silently ungated.
 */
export async function onboardingClaimOrUndefined(
  client: Pick<Client, "execute">,
  authUserId: string,
): Promise<OnboardingClaim | undefined> {
  try {
    return (await computeOnboardingState(client, authUserId)).claim;
  } catch (err) {
    console.error("[onboarding-claim] could not compute the onboarding claim; minting the session without one", {
      authUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Set the session cookie on `res`, exactly as the login route does. */
export function setSessionCookie(res: NextResponse, session: TursoSession): void {
  const maxAge = Math.max(0, session.exp - Math.floor(Date.now() / 1000));
  res.cookies.set({
    name: SESSION_COOKIE,
    value: signSession(session),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

/**
 * Re-mint `session` with a freshly computed claim on `res`. Keeps the same
 * expiry and revocation epoch, so this never extends a session. Returns the
 * claim written (undefined when it could not be computed; the cookie then keeps
 * no claim and is not gated).
 */
export async function reissueWithOnboardingClaim(
  res: NextResponse,
  client: Pick<Client, "execute">,
  session: TursoSession,
): Promise<OnboardingClaim | undefined> {
  const onb = await onboardingClaimOrUndefined(client, session.sub);
  const { onb: _stale, ...rest } = session;
  setSessionCookie(res, onb ? { ...rest, onb } : rest);
  return onb;
}
