/**
 * lib/seat-warning.ts — soft seat-limit advisory for tenant invites.
 *
 * SunBiz product decision #7 (TOMORROW.md, Option B). When an
 * operator invites a new teammate, the dashboard surfaces a soft
 * banner saying "you have N/M seats" so they know billing will
 * adjust on the next cycle. No hard block — Stripe metered billing
 * (when wired) handles the reconciliation.
 *
 * Plan limits are declared here. Tenants without a `seat_limit_soft`
 * value on their plan_tier get no warning.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";

const SEAT_LIMITS_BY_PLAN: Record<string, number> = {
  // Single-operator plans
  free: 1,
  // Small team — original SunBiz Phase-1 sizing
  starter: 3,
  growth: 10,
  pro: 25,
  // Enterprise = no soft cap
};

export type SeatWarning = {
  used: number;
  limit: number | null;
  status: "ok" | "approaching" | "over";
  message: string;
};

export async function computeSeatWarning(
  tenantId: string,
): Promise<SeatWarning | null> {
  const db = getServiceSupabase();
  const [tenantRes, profilesRes] = await Promise.all([
    db
      .from("tenants")
      .select("plan_tier")
      .eq("id", tenantId)
      .maybeSingle(),
    db
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId),
  ]);
  const planTier = (tenantRes.data as { plan_tier: string | null } | null)?.plan_tier;
  const used = profilesRes.count || 0;
  if (!planTier) return null;
  const limit = SEAT_LIMITS_BY_PLAN[planTier];
  if (limit === undefined) {
    // Enterprise / unknown plan: no soft cap.
    return null;
  }
  if (used <= limit - 1) {
    return {
      used,
      limit,
      status: "ok",
      message: `${used} of ${limit} seats used on the ${planTier} plan.`,
    };
  }
  if (used === limit) {
    return {
      used,
      limit,
      status: "approaching",
      message: `${used} of ${limit} seats used. One more invite puts you over your plan — billing will adjust next cycle.`,
    };
  }
  return {
    used,
    limit,
    status: "over",
    message: `${used} of ${limit} seats used — over the ${planTier} plan limit. Billing will adjust next cycle.`,
  };
}
