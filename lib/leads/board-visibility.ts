/**
 * lib/leads/board-visibility.ts — is this lead ON the Leads board?
 *
 * ONE RULE, ONE PLACE. Every surface that answers "which leads are in this
 * section of the Leads tab" must ask this module, including the drip engine.
 *
 * WHY IT EXISTS (Adon, 2026-08-11). He asked why drips were reaching people he
 * could not see, and then, looking at the live board: "There are no [291]
 * merchants in signed applications. We have a lot in viewed but not in signed."
 *
 * He was reading the truth. The board hides transferred leads and the drip
 * engine did not. `listRecords` applied this filter to every lead list surface;
 * `enroller.ts` queried `tenant_records` on `data->>stage` directly and never
 * applied it. Measured on production the same day, SunBiz tenant:
 *
 *   stage                on the board   drip targeted   invisible recipients
 *   signed_application             6             312                    306
 *   viewed_application           175             190                     15
 *   declined                       0              61                     61
 *   dead_file                      0              30                     30
 *   follow_up                    509             512                      3
 *
 * 211 of the 329 drip emails ever sent — 64% — went to merchants who are not on
 * the Leads board. 126 of 521 pending runs were queued to do it again.
 *
 * The rule was already duplicated as a string literal in two places inside
 * lib/manifest/data.ts, which is how it drifted in the first place. Anything
 * that selects leads for a board-shaped audience imports from here instead, so
 * the board and the drips cannot disagree again without a test failing.
 *
 * Pure, no "server-only", so the rule that decides who receives mail stays
 * directly testable.
 */

/**
 * The Live Subs exception is load-bearing, not a special case to tidy away.
 *
 * `uw_sheet` ("Live Subs" in the UI) is an intentional Leads-board work queue.
 * Legacy rows in it were incorrectly stamped `transferred_at` by an old
 * auto-promotion, so a naive "transferred means gone" rule would empty a column
 * operators work out of every day — and, through this module, silence the drip
 * that feeds it. 85 leads sit there today.
 */
export const LEADS_BOARD_EXEMPT_STAGE = "uw_sheet";

/**
 * The PostgREST `.or()` clause. Kept beside the predicate so the query and the
 * in-memory check can never express different rules.
 *
 * Exported as a constant rather than assembled at each call site because it is
 * the exact string the board has always used; changing its shape is a change to
 * what a merchant receives.
 */
export const LEADS_BOARD_OR_FILTER =
  `data->>transferred_at.is.null,data->>stage.eq.${LEADS_BOARD_EXEMPT_STAGE}`;

/**
 * Does this lead appear on the Leads board?
 *
 * Mirrors LEADS_BOARD_OR_FILTER exactly. A lead graduates to the Applications
 * board when it is stamped `transferred_at`; from that moment the Leads tab
 * does not show it, so no lead-stage drip may speak to it.
 *
 * Absent/blank `transferred_at` counts as NOT transferred, matching the SQL
 * `IS NULL` test: PostgREST returns the key as absent rather than null, and
 * treating an absent stamp as "transferred" would empty the whole board.
 */
export function isOnLeadsBoard(data: Record<string, unknown> | null | undefined): boolean {
  const d = data || {};
  if (String(d.stage ?? "").trim() === LEADS_BOARD_EXEMPT_STAGE) return true;
  const transferred = d.transferred_at;
  return transferred === null || transferred === undefined || String(transferred).trim() === "";
}

/**
 * Apply the board filter to a PostgREST query builder.
 *
 * Typed structurally rather than against the Supabase client's generics so this
 * module stays free of a server-only import and remains unit-testable — the
 * builders in lib/manifest/data.ts and lib/drips/enroller.ts both satisfy it.
 */
export function applyLeadsBoardFilter<T extends { or(filter: string): T }>(query: T): T {
  return query.or(LEADS_BOARD_OR_FILTER);
}

/** The synthetic field name a board exit is reported under. Not a real column
 *  and not a status — see BOARD_EXIT_FIELD's only consumer in
 *  lib/portals/stage-hooks.ts. */
export const BOARD_EXIT_FIELD = "__board_exit";

/**
 * Did this write take the lead OFF the Leads board?
 *
 * Reported as a transition so the existing portal stage-hook plumbing can act
 * on it, because the thing that actually happens has no status change at all:
 * `transferred_at` is stamped while `stage` stays exactly where it was. That is
 * why the eager drip-cancel never fired on a transfer, and why a merchant could
 * be moved to the Applications board with a week of queued lead drips still
 * pointed at them.
 *
 * Edge-triggered: fires only on the on-board -> off-board crossing. A lead that
 * was already off the board produces nothing, so re-saving a transferred record
 * cannot re-cancel runs that a later legitimate re-enrolment created.
 *
 * Returns an array so the caller can spread it, and so "no exit" costs nothing.
 */
export function detectBoardExit(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Array<{ field: string; from: unknown; to: unknown }> {
  if (isOnLeadsBoard(after)) return [];
  if (!isOnLeadsBoard(before)) return []; // already gone; not an edge
  return [{ field: BOARD_EXIT_FIELD, from: "on_board", to: "off_board" }];
}
