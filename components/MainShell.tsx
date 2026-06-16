"use client";

/**
 * MainShell — the <main> wrapper that switches between the full-screen
 * "chat shell" (Agents tab) and the normal constrained page layout
 * (every other tab).
 *
 * WHY THIS IS A CLIENT COMPONENT (the bug this fixes):
 * The root layout (app/layout.tsx) is a Server Component. It reads the path
 * from headers() ONCE per full page load and never re-renders on client-side
 * (soft) navigation. So if the chat-shell-vs-constrained decision lives there,
 * it FREEZES at whatever page you first hard-loaded. Loading the Agents tab
 * (chat shell: full-bleed, h-[100dvh], no max-w) and then clicking Shopping
 * Out / Leads / etc. in the sidebar is a soft nav — the <main> stayed the
 * Agents full-screen shell and every other tab rendered full-bleed inside it.
 * Hard-refreshing the other tab "fixed" it, which is why it looked
 * intermittent and kept reverting across two prior width-only fixes.
 *
 * usePathname() updates on EVERY navigation (soft + hard), so the decision is
 * re-evaluated each time — the chat shell is now scoped to /agent for real,
 * and every other route always gets the constrained, footer'd layout.
 *
 * Children stay server-rendered: passing server components through a client
 * component's children prop is fully supported in the App Router.
 */

import { usePathname } from "next/navigation";

// Shared base: sidebar-margin tracking (responds to the data-sidebar collapse
// var on <html>), z-index, mobile-topbar top padding, margin transition.
const MAIN_BASE =
  "ml-0 md:ml-[var(--sidebar-w,15rem)] relative z-10 pt-14 md:pt-0 transition-[margin] duration-200";

// All constrained pages share one width so the CRM routes match the Agents
// tab, Dashboard, and every other surface (no edge-to-edge stretch).
const CONTENT_WIDTH = "max-w-7xl";

/**
 * Chat-shell routes: the Agents tab. Exactly /agent or /agent/* (NOT the
 * legacy plural /agents), plus the /t/<slug>/agent tenant preview path.
 */
function isChatShellPath(pathname: string): boolean {
  return (
    pathname === "/agent" ||
    pathname.startsWith("/agent/") ||
    /^\/t\/[a-z0-9_-]+\/agent(?:\/|$)/i.test(pathname)
  );
}

export function MainShell({
  children,
  footerLabel,
  footerTagline,
}: {
  children: React.ReactNode;
  footerLabel: string;
  footerTagline: string;
}) {
  const pathname = usePathname() || "";

  if (isChatShellPath(pathname)) {
    // Full-screen chat: NO constrained wrapper, NO footer. The Agents page
    // owns the layout and fills 100dvh; overflow-hidden so the chat's own
    // scroll region is the only scroller.
    return (
      <main className={`${MAIN_BASE} h-[100dvh] overflow-hidden`}>{children}</main>
    );
  }

  return (
    <main className={`${MAIN_BASE} min-h-screen`}>
      <div className={`mx-auto ${CONTENT_WIDTH} px-4 md:px-8 py-6 md:py-8`}>
        {children}
      </div>
      <footer className={`mx-auto ${CONTENT_WIDTH} px-8 py-6 text-xs text-fg-faint`}>
        <div className="border-t border-bg-border pt-4 flex justify-between">
          <span>{footerLabel}</span>
          <span>{footerTagline}</span>
        </div>
      </footer>
    </main>
  );
}
