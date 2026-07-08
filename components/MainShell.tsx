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
import type { ChatShellProps } from "@/lib/chat-shell-props";

// Shared base: sidebar-margin tracking (responds to the data-sidebar collapse
// var on <html>), z-index, mobile-topbar top padding, margin transition.
const MAIN_BASE =
  "ml-0 md:ml-[var(--sidebar-w,15rem)] relative z-10 pt-14 md:pt-0 transition-[margin] duration-200";

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
  return /^\/t\/[^/]+\/conversations(\/.*)?$/.test(pathname);
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
}: {
  children: React.ReactNode;
  footerLabel: string;
  footerTagline: string;
  /** Server-resolved props for the persistent ChatWidget. Null when the
   *  tenant has no chat (e.g. a brand-new signup pre-provisioning). */
  chat?: ChatShellProps | null;
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
    // Full-screen chat shell: NO constrained wrapper, NO footer. The page (and,
    // on /agent, the fixed persistent chat below) own the 100dvh viewport;
    // overflow-hidden so the chat's own scroll region is the only scroller.
    <main className={`${MAIN_BASE} h-[100dvh] overflow-hidden`}>{children}</main>
  ) : (
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
          className={
            onAgent
              ? "fixed top-14 md:top-0 left-0 md:left-[var(--sidebar-w,15rem)] right-0 bottom-0 z-20 bg-bg transition-[left] duration-200"
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
