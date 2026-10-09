"use client";

/**
 * Sidebar collapsed-on-desktop state — persisted across page loads via
 * localStorage. Also writes `data-sidebar="collapsed|expanded"` to the
 * document root so global CSS (the main element's left margin) can
 * respond before React hydrates. Without the attribute mirror the
 * page paints once at the default width, then jolts to the collapsed
 * width on hydration — classic FOUC.
 *
 * Storage key is versioned so future schema changes can ignore stale
 * values rather than breaking the layout.
 *
 * The key and the <head> boot script live in lib/sidebar-boot.ts, a plain
 * module: the root layout imports the script, and a value a Server Component
 * imports from this "use client" module reaches the browser as a chunk
 * reference instead of a string (React error #418, 2026-10-08).
 */

import { useCallback, useEffect, useState } from "react";
import { SIDEBAR_COLLAPSED_KEY } from "@/lib/sidebar-boot";

/** The stored choice. Called from effects only, never while rendering. */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function useSidebarCollapsed() {
  // FALSE ON THE SERVER AND IN THE BROWSER'S FIRST RENDER (2026-10-08). The
  // stored choice used to be read right here, in the state initializer, so for
  // anyone who had collapsed the sidebar the browser's first render drew the
  // floating reopen button the server never drew. React found <aside> where it
  // expected that <button>, threw error #418 on every page and redrew the whole
  // page in the browser. The stored choice is read after mount instead, and
  // nothing on screen waits for it: SIDEBAR_BOOT_SCRIPT (lib/sidebar-boot.ts)
  // sets html[data-sidebar] before first paint, and app/globals.css hides the
  // rail and shows the reopen button from that attribute.
  // tests/shell-boundary.test.ts renders the shell both ways and compares.
  const [collapsed, setCollapsedState] = useState(false);
  // True once the stored choice has been read. Until then there is nothing to
  // write back, and writing the default would erase the stored choice.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setCollapsedState(readStored());
    setRestored(true);
  }, []);

  // Reflect changes to the data-attribute + storage on every flip. The
  // attribute is the source of truth for CSS; localStorage is for the
  // next page load.
  useEffect(() => {
    if (!restored) return;
    document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
    } catch {
      // Quota / private mode — no-op. Attribute still tracks.
    }
  }, [collapsed, restored]);

  // Sync across browser tabs so toggling on one tab doesn't leave
  // another tab showing the old state forever.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SIDEBAR_COLLAPSED_KEY) return;
      setCollapsedState(e.newValue === "true");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(() => setCollapsedState((c) => !c), []);
  const setCollapsed = useCallback((value: boolean) => setCollapsedState(value), []);
  return { collapsed, toggle, setCollapsed };
}
