/**
 * lib/sidebar-boot.ts - the sidebar's collapsed-state storage key and the
 * inline script app/layout.tsx puts in <head> to apply it before first paint.
 *
 * THIS MODULE MUST NOT BE "use client" (2026-10-08, React error #418).
 * app/layout.tsx is a Server Component. A value it imports from a "use client"
 * module is not the value: it reaches the browser as a reference to a JS chunk
 * that has to load before React can draw whatever uses it. This script used to
 * be exported by lib/useSidebarCollapsed.ts ("use client"), so the only thing
 * inside <head> arrived as such a reference. Whenever that chunk was still
 * loading when React began hydrating, React paused inside <head>, and React
 * 19.2 loses its place after a pause there: it went on to look for <body>'s
 * first element among <head>'s children, found none, reported "Minified React
 * error #418" (the server's HTML does not match) and threw the server's HTML
 * away to draw the whole page again in the browser. The signed-in crawl saw it
 * on about 1.5% of all page loads, on every kind of page, and on up to a third
 * of the loads that followed a server-side redirect (the app's code was already
 * cached, so hydration started sooner). As a plain string here, <head> arrives
 * complete and React never waits inside it.
 *
 * tests/shell-boundary.test.ts pins it: nothing app/layout.tsx draws inside
 * <head> may come from a "use client" module.
 */

/** Versioned, so a later change to the stored value can ignore stale ones. */
export const SIDEBAR_COLLAPSED_KEY = "oasis.ui.sidebar_collapsed.v1";

/**
 * Runs in <head> before any CSS paints: reads the stored state and writes
 * data-sidebar="collapsed|expanded" on <html>, which the main element's left
 * margin keys off (components/MainShell.tsx). Without it the page paints at
 * the expanded width and visibly jumps when React hydrates the collapsed value.
 * lib/useSidebarCollapsed.ts keeps the attribute and the stored value current
 * after that, under the same key.
 */
export const SIDEBAR_BOOT_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)});document.documentElement.dataset.sidebar=(v==='true')?'collapsed':'expanded';}catch(e){document.documentElement.dataset.sidebar='expanded';}})();`;
