/**
 * components/founders/whiteboard-present.ts - the whiteboard's Present (full
 * screen) mode, as data: what the Present/Exit button says, and whether the
 * board is presenting, from the mode alone.
 *
 * "fullscreen" is the real Fullscreen API, granted; "maximized" is the
 * CSS-only fallback OasisWhiteboard.tsx switches to when the API is absent
 * or the browser refuses the request (a sandboxed iframe with no
 * allow="fullscreen", a user gesture requirement not met, or any other
 * rejection a browser may give `Element.requestFullscreen()`).
 *
 * Pure: no DOM, no window, no document. OasisWhiteboard.tsx is the only file
 * that calls the real Fullscreen API; this file only decides what the
 * button and the board should SHOW once it has, so
 * tests/oasis-whiteboard.test.ts can pin the decision without a browser.
 */

export type PresentMode = "idle" | "fullscreen" | "maximized";

export const PRESENT_LABEL = "Present";
export const EXIT_PRESENTING_LABEL = "Exit presentation";

/** The Present/Exit button's own name: its visible text and its aria-label are the same string. */
export function presentButtonLabel(mode: PresentMode): string {
  return mode === "idle" ? PRESENT_LABEL : EXIT_PRESENTING_LABEL;
}

/** Any mode but idle is presenting, whichever way the board got there. */
export function isPresenting(mode: PresentMode): boolean {
  return mode !== "idle";
}

/**
 * What asking the browser for full screen leads to:
 *   no Fullscreen API at all (apiAvailable=false)     -> "maximized", never asked
 *   asked, and the browser granted it (granted=true)   -> "fullscreen"
 *   asked, and the browser refused it (granted=false)  -> "maximized", the fallback
 */
export function modeAfterRequest(apiAvailable: boolean, granted: boolean): PresentMode {
  if (!apiAvailable) return "maximized";
  return granted ? "fullscreen" : "maximized";
}

/**
 * The board container's own classes, by mode - ONE positioning keyword, never
 * both (Codex review round 2, 2026-10-10: the previous version always carried
 * `relative`, and added `fixed` on top of it for "maximized"; Tailwind's
 * generated stylesheet orders `.relative` after `.fixed`, so `.relative` won
 * every time and the fallback never covered the viewport at all). "idle" and
 * "fullscreen" both stay `relative` and sized to the page - the real
 * Fullscreen API already makes a fullscreened element fill the screen via the
 * browser's own `:fullscreen` UA rule, with no CSS of ours required.
 * "maximized" (the CSS-only fallback, no API or the browser refused it) is
 * `fixed` and never `relative` - the two are mutually exclusive by
 * construction, not by hoping one wins.
 */
export function boardContainerClasses(mode: PresentMode): string {
  const shared = "w-full overflow-hidden bg-bg-deep border-bg-border";
  if (mode === "maximized") return `fixed inset-0 z-50 h-screen w-screen rounded-none border-0 ${shared}`;
  return `relative h-[70vh] min-h-[420px] rounded-2xl border ${shared}`;
}
