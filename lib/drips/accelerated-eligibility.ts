/** Accelerated chase is reserved for Breeze Live Subs. */
export const ACCELERATED_ELIGIBLE_STAGE = "uw_sheet";

export function isAcceleratedEligible(data: Record<string, unknown>): boolean {
  return data.stage === ACCELERATED_ELIGIBLE_STAGE;
}
