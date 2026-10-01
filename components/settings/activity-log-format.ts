/**
 * How the Activity log prints a row: the identifier a writer stored, in words.
 *
 * Pure. Lives beside the page rather than in it because a Next page module
 * may only export what Next expects of a page.
 */

import type { ActivityRow } from "@/lib/audit/activity-feed";

/**
 * "lead.stage_changed" -> "Lead stage changed", "call_started" -> "Call
 * started". A cron's `ran "Daily review"` keeps its quotes; only its first
 * letter changes.
 */
export function humanizeAction(action: string): string {
  const trimmed = action.trim();
  if (!trimmed) return "Change";
  const words = /^ran "/.test(trimmed) ? trimmed : trimmed.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a folded row stands for: "30 leads" when every row names a lead, else "30 times". */
export function groupSummary(row: ActivityRow): string {
  const count = row.count ?? 1;
  const allLeads = (row.items ?? []).length > 0 && (row.items ?? []).every((item) => Boolean(item.leadId));
  return `${count} ${allLeads ? (count === 1 ? "lead" : "leads") : count === 1 ? "time" : "times"}`;
}
