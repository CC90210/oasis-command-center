/**
 * focus-trap — where Tab goes inside an open modal sheet (ConnectorDrawer).
 * Generic over the element type, so tests/os-connectors.test.ts runs it in bare
 * node without a DOM.
 *
 * An aria-modal sheet promises the page behind it is out of reach. Moving focus
 * in on open and back out on close is not enough: Tab from the last control
 * used to walk straight onto the page under the backdrop (CodeRabbit, PR #468).
 */

/** What a modal treats as a Tab stop, in DOM order. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export type TabMove<T> = {
  /** preventDefault the Tab: the browser must not move focus itself. */
  prevent: boolean;
  /** Where to put focus, when this decides it. */
  focus: T | null;
};

/**
 * Tab wraps last → first, Shift+Tab wraps first → last, and focus found outside
 * the sheet is pulled back to its near edge. Anything else is an ordinary Tab
 * between two controls inside the sheet, left to the browser.
 */
export function trapTab<T>(
  focusable: readonly T[],
  active: T | null,
  shiftKey: boolean,
  /** Whether `active` is inside the sheet at all. */
  activeInside: boolean,
): TabMove<T> {
  if (focusable.length === 0) return { prevent: true, focus: null };
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!activeInside || active === null) return { prevent: true, focus: shiftKey ? last : first };
  if (shiftKey && active === first) return { prevent: true, focus: last };
  if (!shiftKey && active === last) return { prevent: true, focus: first };
  return { prevent: false, focus: null };
}
