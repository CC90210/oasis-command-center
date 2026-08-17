"use client";

import { useEffect } from "react";

/**
 * Opens the settings section a URL fragment points at.
 *
 * WHY THIS IS REQUIRED, not a nicety. Collapsing the settings page (2026-08-17,
 * CC: "it should be a bunch of subheadings that I can click on") turned two
 * long-standing anchor targets into closed bars:
 *
 *     /settings#providers  -> "AI setup"
 *     /settings#agents     -> "Override an agent's provider"
 *
 * Eight places link to them, and the ones that matter most are FAILURE states —
 * ChatWidget's "the chat retried 3 times… switch model in Settings", the
 * no-provider-connected prompt, the agents page. Someone follows one of those
 * because something is already broken, lands on the right scroll position, and
 * finds a collapsed header with the control they were sent for hidden inside.
 * The browser scrolls to a `<details>` but does not open it, so the page looks
 * like it simply ignored the link.
 *
 * Handles `hashchange` as well as first paint, because clicking a second
 * `#agents` link while already on /settings fires no navigation — only the
 * fragment changes, and without this the section would never open.
 *
 * Scrolls after opening, not before: the expansion shifts everything below it,
 * so a browser scroll computed against the collapsed layout lands in the wrong
 * place.
 */
export function OpenSectionOnHash() {
  useEffect(() => {
    function openTarget() {
      const hash = window.location.hash;
      if (!hash || hash.length < 2) return;
      let el: Element | null = null;
      try {
        el = document.querySelector(hash);
      } catch {
        // A malformed fragment is not a crash — someone hand-edited the URL.
        return;
      }
      if (!(el instanceof HTMLDetailsElement)) return;
      el.open = true;
      // rAF so the layout reflows with the section expanded before we measure.
      requestAnimationFrame(() => {
        el.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
    openTarget();
    window.addEventListener("hashchange", openTarget);
    return () => window.removeEventListener("hashchange", openTarget);
  }, []);

  return null;
}
