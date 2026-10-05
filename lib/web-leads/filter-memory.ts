/**
 * filter-memory — a rep's filters survive leaving the page.
 *
 * ═══ THE COMPLAINT ══════════════════════════════════════════════════════════
 *
 * Adon, 2026-08-25: "when a rep is on the Leads page and they search for the
 * leads because they are trying to assign themselves to leads... once they
 * click on a lead from those filters or go on the battle card or whatever or
 * click off anything that is not directly on that page, when they go back, they
 * lose their filters. They have to re-click and re-find the leads. We have to
 * add functionality where once you click the filters until you un-click the
 * filters, it's going to stay on that filter no matter where you go."
 *
 * Filters live entirely in the URL query string (lib/web-leads/filters.ts), so
 * they are exact and shareable -- but they die the moment a rep navigates
 * anywhere that is not `/web-leads?...`. Opening a battle card, or clicking any
 * sidebar tab, and coming back lands on a bare `/web-leads` with nothing set.
 * A rep assigning themselves fifty Toronto salons re-picks the province, the
 * city and the industry after every single lead.
 *
 * ═══ WHY THIS IS SAFE TO PERSIST, AND WHEN IT WOULD NOT BE ══════════════════
 *
 * Restoring hidden state is dangerous in this exact product: a filtered list
 * that looks like the whole pool is how "the board reads as clogged" and "the
 * queue looks complete and is not" happened before. It is safe HERE only
 * because LeadsToolbar renders a chip for every active filter plus a "Clear
 * all" button, so a restored filter is visible on screen, nameable, and one
 * click from gone. If that ever stops being true, this must go with it.
 *
 * ═══ WHAT IS DELIBERATELY NOT REMEMBERED ════════════════════════════════════
 *
 * `leadId` -- reopening the drawer on a lead somebody looked at yesterday is
 * not "their filters", and on a claimed lead it would reopen something no
 * longer theirs.
 *
 * `page` -- a remembered page 7 against a pool that has since shrunk renders an
 * empty list, which reads as "there are no leads" rather than "you are past the
 * end". Restoring always lands on page 1 of the remembered filters.
 *
 * ═══ "UNTIL YOU UN-CLICK" ═══════════════════════════════════════════════════
 *
 * Clearing filters is itself a filter change, so it overwrites the memory with
 * an empty string, and an empty memory restores nothing. There is no separate
 * "forget" path to keep in sync -- clearing genuinely clears.
 */

import { parseFilters, filtersToParams } from "./filters";

/**
 * Versioned on purpose. If the filter vocabulary changes, a stored string from
 * the old shape must not be replayed into the new parser -- bumping the key
 * retires every stored value at once, which is cheaper and safer than migrating
 * strings whose meaning has moved.
 */
export const FILTER_MEMORY_KEY = "oasis.web-leads.filters.v1";

/**
 * The canonical, storable form of a filter set: everything except the two
 * fields above. Built through `filtersToParams` rather than by trimming the raw
 * query string, so what is remembered is exactly what the page would produce --
 * a hand-built string could drift from the parser's own idea of a default.
 */
export function memorableQuery(search: string): string {
  const f = parseFilters(new URLSearchParams(search));
  return filtersToParams({ ...f, leadId: null, page: 1 }).toString();
}

/** True when this URL carries no filters at all -- i.e. a rep arrived at a bare
 *  `/web-leads` and there is nothing on screen to lose by restoring. An open
 *  drawer (`?lead=`) does NOT count as a filter, so arriving on a deep link to
 *  one lead still restores the surrounding filters it was found under. */
export function hasNoFilters(search: string): boolean {
  return memorableQuery(search) === "";
}

/** Best-effort read. Storage throws in private modes and when a browser blocks
 *  it; a rep losing their filters is a papercut, a crashed leads page is not. */
export function readRememberedFilters(): string {
  try {
    return window.localStorage.getItem(FILTER_MEMORY_KEY) || "";
  } catch {
    return "";
  }
}

/** Best-effort write, for the same reason. Stores the EMPTY string when filters
 *  are cleared rather than removing the key: both read back as "restore
 *  nothing", and writing is one code path instead of two. */
export function rememberFilters(search: string): void {
  try {
    window.localStorage.setItem(FILTER_MEMORY_KEY, memorableQuery(search));
  } catch {
    /* a rep who cannot store filters simply does not get them back */
  }
}
