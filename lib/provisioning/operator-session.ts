/**
 * The verified platform operator behind this request, or null.
 *
 * For the /api/admin/installs routes. Uses lib/platform-operator.ts (the alias
 * AND an owner/admin OASIS membership read by auth id) rather than
 * lib/role-surfaces-session.ts, whose page guards load next/navigation. Fails
 * closed: a session or membership read that fails is "not an operator".
 */

import "server-only";

import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { getSessionUser } from "@/lib/supabase-server";

export type VerifiedOperator = { authUserId: string; email: string };

export async function operatorFromSession(): Promise<VerifiedOperator | null> {
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser();
  } catch (err) {
    console.error("[provisioning.operator.session]", err);
    return null;
  }
  if (!user?.id || !user.email) return null;
  const check = await resolvePlatformOperatorForAuthUser(user.id, user.email);
  return check.operator ? { authUserId: user.id, email: user.email } : null;
}
