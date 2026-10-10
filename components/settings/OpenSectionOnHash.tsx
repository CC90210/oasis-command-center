"use client";

import { useEffect } from "react";

/**
 * Opens the settings section a URL fragment points at.
 *
 * WHY THIS IS REQUIRED, not a nicety. Collapsing the settings page (2026-08-17,
 * CC: "it should be a bunch of subheadings that I can click on") turned two
 * long-standing anchor targets into closed bars:
 *
 *     /settings#providers  -> "What powers your agents" (AI account)
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
/** What the opener needs from the page; the component passes the browser's, a test passes fakes. */
export type HashEnv = {
  hash: () => string;
  /** The element for a selector, or null. Throws on a malformed selector. */
  find: (selector: string) => OpenableTarget | null;
  /** Calls back on every change to the page's elements; returns the stop function. */
  watch: (onChange: () => void) => () => void;
  /** Runs after the next layout. */
  afterLayout: (run: () => void) => void;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
export type OpenableTarget = {
  tagName: string;
  open?: boolean;
  closest: (selector: string) => OpenableTarget | null;
  scrollIntoView: (options: { block: "start"; behavior: "smooth" }) => void;
};

/** How long a target that is not on the page yet is waited for (a client component fetches before it draws). */
export const HASH_WAIT_MS = 10_000;

/**
 * Opens the section the URL fragment points at, and scrolls to the target.
 *
 * A target that is NOT THERE YET is waited for: #providers sits inside "What
 * powers your agents", whose panel draws only after its own fetch, so on a cold
 * load the first look finds nothing and the browser's own hash scroll has
 * already missed. Watching the page until it appears (at most HASH_WAIT_MS) is
 * what makes every "Connect an AI account" link land on the key card.
 * Returns the stop function.
 */
export function openHashTarget(env: HashEnv): () => void {
  let stopWatch: (() => void) | null = null;
  let giveUp: unknown = null;
  const stop = () => {
    stopWatch?.();
    stopWatch = null;
    if (giveUp !== null) env.clearTimeout(giveUp);
    giveUp = null;
  };
  /** true = nothing more to do (opened, or the fragment is not a selector). */
  function attempt(): boolean {
    const hash = env.hash();
    if (!hash || hash.length < 2) return true;
    let el: OpenableTarget | null;
    try {
      el = env.find(hash);
    } catch {
      // A malformed fragment is not a crash - someone hand-edited the URL.
      return true;
    }
    if (!el) return false;
    // The target is a section, or something inside one: open the section that holds it.
    const section = el.tagName === "DETAILS" ? el : el.closest("details");
    if (section) section.open = true;
    const target = el;
    // After layout, so the expansion has shifted everything before we measure.
    env.afterLayout(() => target.scrollIntoView({ block: "start", behavior: "smooth" }));
    return true;
  }
  if (!attempt()) {
    stopWatch = env.watch(() => {
      if (attempt()) stop();
    });
    giveUp = env.setTimeout(stop, HASH_WAIT_MS);
  }
  return stop;
}

export function OpenSectionOnHash() {
  useEffect(() => {
    let stop: () => void = () => undefined;
    const env: HashEnv = {
      hash: () => window.location.hash,
      find: (selector) => document.querySelector(selector) as unknown as OpenableTarget | null,
      watch: (onChange) => {
        const observer = new MutationObserver(onChange);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
      },
      afterLayout: (run) => {
        requestAnimationFrame(run);
      },
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    };
    function openTarget() {
      stop();
      stop = openHashTarget(env);
    }
    openTarget();
    // A second same-page link fires only hashchange, no navigation.
    window.addEventListener("hashchange", openTarget);
    return () => {
      stop();
      window.removeEventListener("hashchange", openTarget);
    };
  }, []);

  return null;
}
