import "server-only";

import type { User } from "@supabase/supabase-js";
import type { UserProfile } from "@/lib/supabase";
import { getServiceSupabase } from "@/lib/supabase-server";

export type ActiveUserProfile = UserProfile & {
  team_role?: string | null;
  is_owner?: boolean | null;
  onboarding_completed_at?: string | null;
};

export type ActiveProfileResult = {
  profile: ActiveUserProfile | null;
  error: string | null;
};

/** Deterministically choose the signed-in identity from legacy duplicate rows. */
export function chooseActiveProfile(
  rows: ActiveUserProfile[],
  email: string | null | undefined,
): ActiveUserProfile {
  if (rows.length === 1) return rows[0];
  const normalizedEmail = (email || "").trim().toLowerCase();
  const exactEmail = normalizedEmail
    ? rows.filter((row) => (row.email || "").trim().toLowerCase() === normalizedEmail)
    : [];
  const candidates = exactEmail.length > 0 ? exactEmail : rows;
  // Preserve the app's established active-profile precedence, but remove the
  // database-order lottery. Within the same tier the most recently updated row
  // is authoritative; the primary key is the stable final tiebreaker. We do not
  // blindly prefer a more privileged role, because a stale admin duplicate must
  // not elevate a current sales profile.
  const tier = (row: ActiveUserProfile) =>
    row.is_owner && row.onboarding_completed_at
      ? 3
      : row.onboarding_completed_at
        ? 2
        : row.is_owner
          ? 1
          : 0;
  const updatedAt = (row: ActiveUserProfile) => {
    const value = Date.parse(row.updated_at || "");
    return Number.isFinite(value) ? value : 0;
  };
  return [...candidates].sort(
    (left, right) =>
      tier(right) - tier(left) ||
      updatedAt(right) - updatedAt(left) ||
      left.id.localeCompare(right.id),
  )[0];
}

/**
 * Resolve the same canonical profile for pages and APIs. Auth-id matching wins;
 * email is only the post-migration fallback used when no auth-linked row exists.
 */
export async function resolveActiveProfileForUser(
  user: Pick<User, "id" | "email">,
): Promise<ActiveProfileResult> {
  const db = getServiceSupabase();
  const byAuth = await db
    .from("user_profiles")
    .select("*")
    .eq("auth_user_id", user.id)
    .limit(20);
  if (byAuth.error) return { profile: null, error: byAuth.error.message };

  const authRows = (byAuth.data || []) as ActiveUserProfile[];
  if (authRows.length > 0) {
    return { profile: chooseActiveProfile(authRows, user.email), error: null };
  }

  if (!user.email) return { profile: null, error: null };
  const byEmail = await db
    .from("user_profiles")
    .select("*")
    .eq("email", user.email)
    .limit(20);
  if (byEmail.error) return { profile: null, error: byEmail.error.message };
  const emailRows = (byEmail.data || []) as ActiveUserProfile[];
  return {
    profile: emailRows.length > 0 ? chooseActiveProfile(emailRows, user.email) : null,
    error: null,
  };
}
