/**
 * lib/seat-warning-policy.ts — pure plan-limit lookup + warning
 * classifier. Lives in a non-server-only module so the test runtime
 * can import it directly. Companion to lib/seat-warning.ts which
 * does the DB roundtrip and calls this.
 *
 * Other callers that need to read plan caps (billing UI, admin
 * dashboards, future tenant-provisioning flows) should import from
 * here too rather than re-declaring the limits map.
 */

export const SEAT_LIMITS_BY_PLAN: Readonly<Record<string, number>> = {
  free: 1,
  starter: 3,
  growth: 10,
  pro: 25,
  // enterprise = no soft cap (omitted on purpose)
};

export type SeatWarningStatus = "ok" | "approaching" | "over";

export type SeatWarning = {
  used: number;
  limit: number | null;
  status: SeatWarningStatus;
  message: string;
};

/** Returns the seat cap for a plan tier, or null when the tier has no
 *  soft cap (enterprise / unknown). */
export function getSeatLimitForPlan(planTier: string | null | undefined): number | null {
  if (!planTier) return null;
  const limit = SEAT_LIMITS_BY_PLAN[planTier];
  return typeof limit === "number" ? limit : null;
}

/** Classify (used, limit, planTier) into a SeatWarning. Pure function;
 *  no DB. When limit is null returns null (no cap → no warning). */
export function classifySeatUsage(args: {
  used: number;
  planTier: string | null | undefined;
}): SeatWarning | null {
  const limit = getSeatLimitForPlan(args.planTier);
  if (limit === null) return null;
  const used = Math.max(0, Math.floor(args.used));
  if (used <= limit - 1) {
    return {
      used,
      limit,
      status: "ok",
      message: `${used} of ${limit} seats used on the ${args.planTier} plan.`,
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
    message: `${used} of ${limit} seats used — over the ${args.planTier} plan limit. Billing will adjust next cycle.`,
  };
}
