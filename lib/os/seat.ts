/**
 * lib/os/seat.ts — liveSeat: whether a (tenant, auth user) pair is still a
 * REAL seat, right now. One answer, used everywhere "is this person still
 * here" is asked: ping, poll, records, the department viewer, and every MCP
 * call (O3a security rule 6).
 *
 * THREE FACTS, all required:
 *   1. a user_profiles row for this auth user, IN THIS WORKSPACE, with
 *      deactivated_at IS NULL;
 *   2. the auth user itself is not banned or deleted (_supabase_auth_users);
 *   3. when the caller carries a session_version (a token minted with one),
 *      it still matches the current value -- a password change or a
 *      deactivation bumps it, which invalidates every token that predates it,
 *      the same way lib/turso-auth.ts verifySessionAgainstDb invalidates a
 *      stale cookie.
 *
 * WHY ITS OWN MODULE. Before this, the MCP seat check
 * (components/os/department/viewer.ts resolveOsViewerFor) read none of
 * these three facts -- a removed member's bearer kept working until the MCP
 * token itself expired. Fixing it inline would have left ping/poll/records
 * to grow their own, slightly different, version. One module, one set of
 * facts, fails CLOSED on every read error (never "live" on a read it could
 * not finish).
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { dbBool } from "@/lib/db-bool";
import { chooseActiveProfile, type ActiveUserProfile } from "@/lib/active-profile-resolver";

export type LiveProfile = {
  id: string;
  email: string | null;
  teamRole: string;
  isOwner: boolean;
  adminAccess: boolean;
};

export type SeatLiveness =
  | { live: true; profile: LiveProfile }
  | {
      live: false;
      reason:
        | "no_profile" // no row for this auth user in this workspace
        | "deactivated" // every row this auth user has here is deactivated
        | "banned_or_deleted" // the auth user itself is gone
        | "session_version_mismatch" // the bearer predates a password change / removal
        | "unavailable"; // a read failed -- never reads as live
    };

type ProfileRow = {
  id: string;
  email: string | null;
  team_role: string | null;
  is_owner: unknown;
  admin_access: unknown;
  deactivated_at: string | null;
  onboarding_completed_at: string | null;
  updated_at: string | null;
};

type AuthRow = {
  banned_until?: string | null;
  deleted_at?: string | null;
  session_version?: unknown;
};

/** True when `bannedUntil` names a moment still in the future (still banned). */
function stillBanned(bannedUntil: string | null | undefined, nowMs: number): boolean {
  if (!bannedUntil) return false;
  const ms = Date.parse(bannedUntil);
  // An unparsable value fails closed: never read as "not banned".
  return !Number.isFinite(ms) || ms > nowMs;
}

export async function liveSeat(
  tenantId: string,
  authUserId: string,
  sessionVersion?: number,
): Promise<SeatLiveness> {
  if (!tenantId || !authUserId) return { live: false, reason: "no_profile" };
  try {
    const db = getServiceSupabase();
    const profileRead = await db
      .from("user_profiles")
      .select("id, email, team_role, is_owner, admin_access, deactivated_at, onboarding_completed_at, updated_at")
      .eq("auth_user_id", authUserId)
      .eq("tenant_id", tenantId)
      .limit(20);
    if (profileRead.error) throw new Error(profileRead.error.message);
    const rows = (profileRead.data || []) as ProfileRow[];
    if (rows.length === 0) return { live: false, reason: "no_profile" };
    const active = rows.filter((r) => !r.deactivated_at);
    if (active.length === 0) return { live: false, reason: "deactivated" };
    // A duplicate-row tenant (legacy data) uses the SAME canonical pick every
    // other seat resolver uses (lib/active-profile-resolver.ts
    // chooseActiveProfile: onboarded-owner > onboarded > owner > plain,
    // newest updated_at, then id, as the tiebreakers) — not just "any owner
    // row": an unfinished, never-onboarded owner duplicate must never outrank
    // a live, onboarded member row (Codex review, O3a).
    const row = chooseActiveProfile(active as unknown as ActiveUserProfile[], null);

    const authRead = await db
      .from("_supabase_auth_users")
      .select("id, banned_until, deleted_at, session_version")
      .eq("id", authUserId)
      .maybeSingle();
    if (authRead.error) throw new Error(authRead.error.message);
    const authRow = authRead.data as AuthRow | null;
    if (!authRow) return { live: false, reason: "banned_or_deleted" };
    if (authRow.deleted_at) return { live: false, reason: "banned_or_deleted" };
    if (stillBanned(authRow.banned_until, Date.now())) return { live: false, reason: "banned_or_deleted" };

    if (sessionVersion !== undefined) {
      const current = Number(authRow.session_version ?? 0);
      if (!Number.isSafeInteger(current) || current !== sessionVersion) {
        return { live: false, reason: "session_version_mismatch" };
      }
    }

    return {
      live: true,
      profile: {
        id: row.id,
        email: row.email ?? null,
        teamRole: row.team_role || "read_only",
        isOwner: dbBool(row.is_owner),
        adminAccess: dbBool(row.admin_access),
      },
    };
  } catch (err) {
    console.error("[os.seat.liveSeat]", {
      tenantId,
      authUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { live: false, reason: "unavailable" };
  }
}
