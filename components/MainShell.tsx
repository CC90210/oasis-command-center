"use client";

/**
 * MainShell — the <main> wrapper that switches between the full-screen
 * "chat shell" (Agents tab) and the normal constrained page layout
 * (every other tab), AND hosts the ONE persistent ChatWidget instance.
 *
 * WHY THIS IS A CLIENT COMPONENT (the bug this fixes):
 * The root layout (app/layout.tsx) is a Server Component. It reads the path
 * from headers() ONCE per full page load and never re-renders on client-side
 * (soft) navigation. So if the chat-shell-vs-constrained decision lives there,
 * it FREEZES at whatever page you first hard-loaded. usePathname() updates on
 * EVERY navigation (soft + hard), so the decision is re-evaluated each time.
 *
 * WHY THE CHATWIDGET LIVES HERE (chat persistence, 2026-06-18):
 * ChatWidget used to be mounted INSIDE app/agent/page.tsx. A soft nav away
 * from /agent unmounted the page → unmounted ChatWidget → tore down the live
 * fetch/stream and dropped the entire in-flight turn (the transcript, tool
 * pills, streaming buffer all live in that component's React state, with no
 * abort-on-unmount). Hoisting the single ChatWidget into MainShell — which
 * survives soft navigation — means the instance NEVER unmounts on nav, so an
 * agent you set running keeps running and is still there (with its output)
 * when you click back to the Agents tab. The widget is kept mounted and just
 * CSS-hidden (display:none) on non-chat routes; it is NEVER unmounted by nav.
 *
 * Children stay server-rendered: passing server components through a client
 * component's children prop is fully supported in the App Router.
 */

import { usePathname } from "next/navigation";
import { useRef } from "react";
import ChatWidget from "@/components/ChatWidget";
import { ContentHeader, type ContentHeaderProps } from "@/components/os/ContentHeader";
import type { ChatShellProps } from "@/lib/chat-shell-props";

// Shared base: sidebar-margin tracking (responds to the data-sidebar collapse
// var on <html>), z-index, mobile-topbar top padding, margin transition.
//
// OASIS OS CANVAS: `os-canvas-main` (app/globals.css) insets the page 0.5rem
// from the window at md+, flush against the open rail, and `os-canvas-frame`
// gives the inner wrapper a hairline edge and rounded corners. The rail sits
// on the ground with no border; this edge is the separation. Plain CSS because
// the left inset depends on html[data-sidebar], which is set before paint.
const MAIN_BASE =
  "ml-0 md:ml-[var(--sidebar-w,15rem)] relative z-10 pt-14 md:pt-0 transition-[margin] duration-150 os-canvas-main";
const CANVAS = "os-canvas-frame bg-bg";

// All constrained pages share one width so the CRM routes match the Agents
// tab, Dashboard, and every other surface (no edge-to-edge stretch).
const CONTENT_WIDTH = "max-w-7xl";

/**
 * Chat-shell routes — these get the full-bleed, footer-less <main>. Exactly
 * /agent or /agent/* (NOT the legacy plural /agents), plus the /t/<slug>/agent
 * tenant preview path (which renders a DIFFERENT component, AgentChat).
 */
function isChatShellPath(pathname: string): boolean {
  return (
    pathname === "/agent" ||
    pathname.startsWith("/agent/") ||
    /^\/t\/[a-z0-9_-]+\/agent(?:\/|$)/i.test(pathname)
  );
}

/**
 * Full-bleed routes — the Conversations 3-pane inbox. Same treatment as the
 * chat shell (no max-w-7xl, no footer, h-[100dvh] overflow-hidden) but a
 * SEPARATE predicate from isChatShellPath: conversations never renders
 * ChatWidget, it's just an inbox that also wants the full viewport. One
 * boolean, mirroring the isChatShellPath pattern above (plan §2a,
 * apex/conversations-inbox-v2 Phase 1).
 */
function isFullBleedPath(pathname: string): boolean {
  // /schedule is a calendar: it owns the viewport and scrolls its own grid.
  return /^\/t\/[^/]+\/conversations(\/.*)?$/.test(pathname) || pathname === "/schedule";
}

/**
 * The OPERATOR'S OWN agent chat — where the persistent ChatWidget is visible.
 * Narrower than isChatShellPath on purpose: the /t/<slug>/agent preview path
 * renders AgentChat, not ChatWidget, so the persistent instance must stay
 * hidden there (it speaks as the operator's own tenant, not the previewed one).
 */
function isOwnAgentChatPath(pathname: string): boolean {
  return pathname === "/agent" || pathname.startsWith("/agent/");
}

export function MainShell({
  children,
  footerLabel,
  footerTagline,
  chat,
  header = null,
}: {
  children: React.ReactNode;
  footerLabel: string;
  footerTagline: string;
  /** Server-resolved props for the persistent ChatWidget. Null when the
   *  tenant has no chat (e.g. a brand-new signup pre-provisioning). */
  chat?: ChatShellProps | null;
  /** The OS content header (breadcrumb + Ask). Null on the preview/demo
   *  shells, which render another workspace's manifest and have no OS rail. */
  header?: ContentHeaderProps | null;
}) {
  const pathname = usePathname() || "";
  const onAgent = isOwnAgentChatPath(pathname);
  const chatShell = isChatShellPath(pathname) || isFullBleedPath(pathname);

  // Lazy-mount: don't pay the ChatWidget's prewarm / bridge-probe / config
  // fetches on pages where chat was never opened. Latch activation DURING
  // render (not via a post-paint effect) so the first soft-nav to /agent mounts
  // the chat overlay in the SAME render — no one-frame flash of the page
  // fallback. Once true, it stays true for the shell's lifetime so the
  // transcript survives every subsequent navigation.
  const activatedRef = useRef(onAgent);
  if (onAgent) activatedRef.current = true;
  const chatActivated = activatedRef.current;

  const mainEl = chatShell ? (
    // Full-screen chat shell: NO constrained wrapper, NO footer, NO content
    // header. The page (and, on /agent, the fixed persistent chat below) own
    // the viewport; overflow-hidden so the chat's own scroll region is the
    // only scroller. The canvas frame is h-full of the padded main, so a
    // child sized h-full still fills exactly the visible panel.
    <main className={`${MAIN_BASE} h-[100dvh] overflow-hidden`}>
      <div className={`${CANVAS} h-full overflow-hidden`}>{children}</div>
    </main>
  ) : (
    <main className={`${MAIN_BASE} min-h-screen`}>
      <div className={`${CANVAS} flex min-h-[calc(100dvh-3.5rem)] flex-col md:min-h-[calc(100dvh-1rem)]`}>
        {header && <ContentHeader {...header} />}
        <div className={`mx-auto w-full flex-1 ${CONTENT_WIDTH} px-4 md:px-8 py-6 md:py-8`}>
          {children}
        </div>
        <footer className={`mx-auto w-full ${CONTENT_WIDTH} px-4 md:px-8 py-6 text-xs text-fg-dim`}>
          <div className="border-t border-hairline pt-4 flex flex-wrap items-center justify-between gap-y-2">
            <span>{footerLabel}</span>
            <div className="flex items-center gap-4">
              {/* Platform legal links. Deliberately UNBRANDED: this footer also
                  renders under a client tenant's shell (SunBiz et al), and the
                  2026-05-25 cross-tenant audit removed "Powered by OASIS AI"
                  from tenant surfaces. The distinction that makes these links
                  correct anyway — unlike on the public form — is WHO is reading:
                  an operator inside the Command Center is the platform's own
                  customer and these terms genuinely govern their use, whereas a
                  lead filling out a tenant's public form is not. Keep them
                  label-neutral so a SunBiz operator sees "Privacy", not
                  "OASIS AI Privacy". */}
              <a href="/privacy" className="hover:text-fg-muted">Privacy</a>
              <a href="/terms" className="hover:text-fg-muted">Terms</a>
              <span>{footerTagline}</span>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );

  return (
    <>
      {mainEl}
      {/* The single persistent ChatWidget. Mounted once (lazily) and kept alive
          across all soft navigation; visibility is CSS-only so the live stream
          and transcript are never torn down. The positioning div is the same
          fixed/var-driven box that used to live in app/agent/page.tsx — being
          `fixed` + --sidebar-w-driven, it self-positions regardless of where in
          the tree it renders, which is what makes the hoist safe. */}
      {chat && chatActivated && (
        <div
          // `os-canvas-overlay` (app/globals.css) floats it on the same inset,
          // hairline-edged canvas as every other page at md+ and tracks the
          // collapsed rail; below md it is the old edge-to-edge box under the
          // mobile top bar.
          className={
            onAgent
              ? "fixed top-14 left-0 right-0 bottom-0 z-20 bg-bg os-canvas-overlay transition-[left] duration-150"
              : "hidden"
          }
          aria-hidden={!onAgent}
        >
          <ChatWidget
            agentKeys={chat.agentKeys}
            defaultAgent={chat.defaultAgent}
            isAdmin={chat.isAdmin}
            welcomeMessages={chat.welcomeMessages}
            advancedPicker={chat.advancedPicker}
            variant="fullscreen"
            // Off /agent the instance stays mounted (transcript survives) but
            // pauses its prewarm + 30s health poll so it isn't working on every
            // page. The live stream reader is unaffected.
            active={onAgent}
          />
        </div>
      )}
    </>
  );
}
