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
 */

import { useCallback, useEffect, useState } from "react";

export const SIDEBAR_COLLAPSED_KEY = "oasis.ui.sidebar_collapsed.v1";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function useSidebarCollapsed() {
  // useState's initializer reads localStorage exactly once before paint
  // so we don't have a flash of "expanded" → "collapsed" on every nav.
  // The data-attribute on <html> is also set in a synchronous script
  // in the layout (RootScript below), giving the CSS the value before
  // React even mounts.
  const [collapsed, setCollapsedState] = useState<boolean>(readInitial);

  // Reflect changes to the data-attribute + storage on every flip. The
  // attribute is the source of truth for CSS; localStorage is for the
  // next page load.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
    } catch {
      // Quota / private mode — no-op. Attribute still tracks.
    }
  }, [collapsed]);

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

/**
 * Inline script string we render in `<head>` to set the data-attribute
 * synchronously, BEFORE any CSS paints. Without this the page's first
 * paint uses the expanded sidebar width and visibly shifts when React
 * hydrates and applies the collapsed value.
 */
export const SIDEBAR_BOOT_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)});document.documentElement.dataset.sidebar=(v==='true')?'collapsed':'expanded';}catch(e){document.documentElement.dataset.sidebar='expanded';}})();`;
