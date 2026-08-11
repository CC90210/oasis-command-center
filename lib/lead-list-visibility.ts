/**
 * DEPRECATED SHIM — the rule now lives in lib/leads/board-visibility.ts.
 *
 * This file held a THIRD copy of the Leads-board visibility rule, alongside the
 * two string literals in lib/manifest/data.ts. Three copies is how the drip
 * engine came to be mailing 306 merchants that the board does not show.
 *
 * Its old body was `!data.transferred_at || data.stage === "uw_sheet"`, which
 * also carried the blank-string divergence Codex flagged on the new module:
 * `!""` is true, so a blank-stamped lead read as VISIBLE here while the server
 * query hid it. Re-exporting fixes that in the client component too.
 *
 * Kept as a one-line re-export rather than deleted so any in-flight branch
 * importing it keeps compiling and silently gets the corrected rule. New code
 * should import `isOnLeadsBoard` directly.
 */

export { isOnLeadsBoard as isLeadListVisible } from "@/lib/leads/board-visibility";
