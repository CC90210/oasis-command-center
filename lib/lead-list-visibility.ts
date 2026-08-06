/** Live Subs stay on the Leads board even when a legacy transfer marker exists. */
export function isLeadListVisible(data: Record<string, unknown>): boolean {
  return !data.transferred_at || data.stage === "uw_sheet";
}
