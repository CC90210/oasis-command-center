/**
 * lib/seat-warning.ts — DB-touching wrapper around the pure policy in
 * lib/seat-warning-policy. SunBiz product decision #7 (TOMORROW.md,
 * Option B). When an operator invites a new teammate, the dashboard
 * surfaces a soft banner saying "you have N/M seats" so they know
 * billing will adjust on the next cycle. No hard block — Stripe
 * metered billing (when wired) handles the reconciliation.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import {
  classifySeatUsage,
  type SeatWarning,
} from "@/lib/seat-warning-policy";

export type { SeatWarning } from "@/lib/seat-warning-policy";

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
  return classifySeatUsage({ used, planTier });
}
