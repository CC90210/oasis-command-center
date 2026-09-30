"use client";

/**
 * Sidebar — the rail's container: the fixed <aside>, its collapse transform,
 * the mobile drawer semantics, the deferred operator status read, and intent
 * prefetch. What goes INSIDE depends on the shell:
 *
 *   `sections` present → the OASIS OS rail (components/os/OsRail.tsx), built
 *                        on the server by lib/os/nav.ts. Every workspace's own
 *                        shell takes this path.
 *   `sections` absent  → the manifest nav (`items`), flat and grouped. Only the
 *                        /t/<slug> preview and demo shells take this path:
 *                        they render ANOTHER workspace's manifest, and demo mode
 *                        rewrites every link to the demo landing (demoHref).
 *
 * The rail sits on the window ground with no right border (OS spec §(d)); the
 * canvas edge in MainShell is the separation. On mobile the drawer overlays the
 * page, so there it takes a hairline and an overlay shadow.
 */

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Crown, PanelLeftClose, LogOut, SunMedium, X } from "lucide-react";
import { OsRail } from "@/components/os/OsRail";
import { iconFor } from "@/components/os/RailRow";
import type { ConnectionsStatus } from "@/components/os/RailFooter";
import { CC_NAV, type NavItem } from "@/lib/nav-config";
import type { OsNavSection } from "@/lib/os/types";
import { demoHref } from "@/lib/demo-href";
import { prefetchRememberedWebLeads } from "@/lib/web-leads/client-cache";

/** A status field that is not a real boolean was not checked: null, not false. */
function knownOrNull(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

export function Sidebar({
  // Neutralized 2026-05-25 — these defaults used to silently fall
  // back to OASIS branding when a caller forgot to pass props,
  // which would render OASIS chrome on a Sun Biz route. Now the
  // fallback is brand-agnostic; if a caller doesn't pass brand,
  // the sidebar reads "Command Center" instead of "OASIS AI".
  brand = "Command Center",
  logo = "oasis",
  subtitle = "Agent Command Center",
  items,
  sections = null,
  isOperator = false,
  showConnections = false,
  connectionsStatus = null,
  notifications,
  badges,
  operatorName,
  operatorEmail,
  primaryAgent = "bravo",
  primaryAgentLive: primaryAgentLiveProp = false,
  bridgeOnline: bridgeOnlineProp = false,
  deferStatus = false,
  inboxUnread = 0,
  demoMode = false,
  demoLabel = "Client demo",
  demoLandingPath,
  isMobileOpen = false,
  onMobileClose,
  onDesktopCollapse,
  isDesktopCollapsed = false,
}: {
  brand?: string;
  logo?: "oasis" | "sunbiz" | "suga";
  subtitle?: string;
  /** Manifest nav for the preview/demo shells. Ignored when `sections` is set. */
  items?: NavItem[];
  /** OASIS OS sections from lib/os/nav.ts buildOsNav. Set = the OS rail. */
  sections?: OsNavSection[] | null;
  /** resolvePlatformOperator(): the Admin shield. OS rail only. */
  isOperator?: boolean;
  /** Owners/admins get the Connections door in the footer. OS rail only. */
  showConnections?: boolean;
  /** Measured connection health, or null for no dot. OS rail only. */
  connectionsStatus?: ConnectionsStatus | null;
  /** Notifications slot in the footer. OS rail only. */
  notifications?: ReactNode;
  /** Counter map keyed by NavItem.badgeKey (e.g. {inbox: 3, applications: 247}). */
  badges?: Record<string, number>;
  operatorName?: string;
  operatorEmail?: string;
  primaryAgent?: string;
  primaryAgentLive?: boolean;
  bridgeOnline?: boolean;
  /** P1 instant-load: when true, the live/bridge dots start from the passed
   *  booleans (typically false) and self-resolve from /api/shell/status
   *  after paint — the layout no longer blocks first byte on those reads.
   *  The layout passes true only for a platform operator on their own
   *  shell: the dots live in the Admin view, so nobody else pays for the
   *  read. Preview/demo shells pass false. */
  deferStatus?: boolean;
  inboxUnread?: number;
  demoMode?: boolean;
  demoLabel?: string;
  /** Where in-demo clicks land so navigation doesn't leak into the OASIS shell. Unset: demoHref's "/". */
  demoLandingPath?: string;
  /** Mobile drawer open state — controlled by SidebarShell. Ignored at md+. */
  isMobileOpen?: boolean;
  /** Mobile drawer close handler. Required for the close button inside the
   *  drawer to work. Ignored at md+. */
  onMobileClose?: () => void;
  /** Desktop collapse handler — wired by SidebarShell to flip the
   *  localStorage-backed collapsed state. Renders the PanelLeftClose
   *  affordance inside the brand block when present. */
  onDesktopCollapse?: () => void;
  /** Whether the desktop sidebar is currently collapsed. Drives the
   *  translate-x animation. Ignored on mobile (drawer state wins). */
  isDesktopCollapsed?: boolean;
}) {
  const pathname = usePathname();
  // Deferred chrome status (P1 instant-load): fetched once after paint so
  // the layout never blocks first byte on the snapshot/bridge reads. A
  // failed fetch leaves the dots at their passed (off) values — chrome
  // degrades, the page does not.
  // bridgeOnline is null when /api/shell/status could not read the pairings:
  // the rail says "couldn't check", never "offline" (2026-09-29).
  const [fetchedStatus, setFetchedStatus] = useState<{
    primaryAgentLive: boolean;
    bridgeOnline: boolean | null;
  } | null>(null);
  // Cached per browser session (60s). MEASURED on production 2026-09-04: this
  // endpoint costs 1,540-2,475 ms and it fired on EVERY full page load, making
  // it the single most expensive background request left after the idle-prefetch
  // removal. It powers two decorative status dots — "is the agent ticking",
  // "is the bridge up" — which nobody needs fresher than a minute, and which
  // already render "off" without it. sessionStorage (not localStorage) so it
  // dies with the tab and never becomes stale state on a shared machine; the
  // payload is two booleans, no PII.
  useEffect(() => {
    if (!deferStatus) return;
    // DROP THE PREVIOUS OPERATOR'S VALUES FIRST (Codex P1 follow-up,
    // 2026-09-04). Scoping the storage key is not sufficient on its own: if
    // this sidebar stays mounted across an identity change, React state still
    // holds the old operator's dots, and a failed or slow lookup for the new
    // one would leave them on screen indefinitely. Clearing here makes the
    // dots fall back to the passed-in "off" state — the honest default —
    // until the new, session-gated answer arrives.
    setFetchedStatus(null);
    // KEYED PER OPERATOR (Codex P1, 2026-09-04). sessionStorage survives a
    // sign-out/sign-in inside the same tab, so a single global key would hand
    // the NEXT operator the previous one's tenant-specific agent/bridge status
    // for up to the TTL, without ever calling the session-gated endpoint —
    // a cross-tenant signal leak wearing the clothes of a cache hit.
    //
    // The identity is folded into a short non-cryptographic hash rather than
    // stored raw: it only has to DISTINGUISH operators, and an email address
    // does not belong in a storage key. No operator identity => no caching at
    // all (fail closed toward a fresh, session-gated read).
    const identity = operatorEmail?.trim().toLowerCase();
    if (!identity) {
      let cancelled = false;
      fetch("/api/shell/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d) return;
          setFetchedStatus({
            primaryAgentLive: d.primaryAgentLive === true,
            bridgeOnline: knownOrNull(d.bridgeOnline),
          });
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
    let h = 5381;
    for (let i = 0; i < identity.length; i++) h = ((h << 5) + h + identity.charCodeAt(i)) >>> 0;
    const KEY = `shell-status-v1:${h.toString(36)}`;
    const TTL_MS = 60_000;
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { at: number; primaryAgentLive: boolean; bridgeOnline: boolean | null };
        if (Date.now() - cached.at < TTL_MS) {
          setFetchedStatus({
            primaryAgentLive: cached.primaryAgentLive === true,
            bridgeOnline: knownOrNull(cached.bridgeOnline),
          });
          return;
        }
      }
    } catch {
      // A blocked or full sessionStorage must not cost the operator the dots.
    }
    let cancelled = false;
    fetch("/api/shell/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const next = {
          primaryAgentLive: d.primaryAgentLive === true,
          bridgeOnline: knownOrNull(d.bridgeOnline),
        };
        setFetchedStatus(next);
        try {
          sessionStorage.setItem(KEY, JSON.stringify({ ...next, at: Date.now() }));
        } catch {
          // fail-open: caching is an optimisation, never a requirement
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deferStatus, operatorEmail]);
  const primaryAgentLive = deferStatus
    ? fetchedStatus?.primaryAgentLive ?? primaryAgentLiveProp
    : primaryAgentLiveProp;
  // Not `??`: a fetched null ("couldn't check") must not fall back to the
  // passed-in false and read as "offline".
  const bridgeOnline: boolean | null = deferStatus
    ? fetchedStatus ? fetchedStatus.bridgeOnline : bridgeOnlineProp
    : bridgeOnlineProp;
  // Before the deferred read answers, the dots are UNKNOWN, not "off".
  const statusKnown = deferStatus ? fetchedStatus !== null : true;
  const navItems = items && items.length > 0 ? items : CC_NAV;
  const onWebLeads = pathname === "/web-leads" || pathname.startsWith("/web-leads/");
  const railHasWebLeads = sections
    ? sections.some((s) => s.groups.some((g) => g.rows.some((r) => r.href === "/web-leads")))
    : navItems.some((item) => item.href === "/web-leads");
  const canPrefetchWebLeads = !demoMode && !onWebLeads && railHasWebLeads;
  const prefetchWebLeads = useCallback(() => {
    if (!canPrefetchWebLeads) return;
    void prefetchRememberedWebLeads();
  }, [canPrefetchWebLeads]);
  const intentFor = useCallback(
    (href: string) => (href === "/web-leads" ? prefetchWebLeads : undefined),
    [prefetchWebLeads],
  );

  // ═══ NO UNCONDITIONAL IDLE PREFETCH ═══════════════════════════════════════
  //
  // There used to be an idle-callback here that fired prefetchRememberedWebLeads()
  // on EVERY page an operator opened. MEASURED IN A REAL LOGGED-IN BROWSER
  // (manager on the web-dev tenant, production, 2026-09-03) while loading
  // /pipeline — a page that has nothing to do with the leads list:
  //
  //   /api/web-leads          3,908 ms   <- this idle prefetch
  //   /settings?_rsc=         1,389 ms
  //   /api/shell/status       1,339 ms
  //   /?_rsc=                   962 ms
  //   /web-leads?_rsc=          916 ms
  //   /playbook?_rsc=           328 ms
  //
  // Six concurrent background requests starting ~790 ms in, right after first
  // contentful paint at 808 ms. The page painted fast and then the browser and
  // the server were busy for four more seconds — so the NEXT click queued behind
  // work the operator never asked for. Measured on its own, /api/web-leads costs
  // 989-2,647 ms. That is the "everything feels slow" everyone was reporting,
  // and it is self-inflicted.
  //
  // Prefetching on INTENT (hover/focus, wired via onIntent below) keeps the win
  // this was reaching for without paying it on every page: an operator heading
  // for Web Leads still warms the cache before the click lands, and an operator
  // working in Pipeline is left alone.
  //
  // Pinned by tests/perf-prefetch.test.ts. If you reintroduce an idle prefetch,
  // measure a real logged-in navigation first — this cost was invisible to
  // query-level timing, which is why it survived three optimization phases.

  // Longest-prefix-wins active highlight. The naive
  //   pathname.startsWith(item.href)
  // rule lit BOTH Dashboard (/t/sun) AND Reasoning (/t/sun/reasoning) when
  // the user was on /t/sun/reasoning, because the Dashboard prefix is a
  // proper prefix of the Reasoning path. Computing the single best match
  // once means only the longest-matching nav item highlights.
  const bestMatchHref = (() => {
    let bestLen = -1;
    let bestHref: string | null = null;
    for (const item of navItems) {
      const href = item.href;
      const matches =
        href === "/"
          ? pathname === "/"
          : pathname === href || pathname.startsWith(href + "/");
      if (matches && href.length > bestLen) {
        bestLen = href.length;
        bestHref = href;
      }
    }
    return bestHref;
  })();

  // Merge the legacy inboxUnread prop into the badges map so the existing
  // layout.tsx callers keep working without code changes.
  const badgeMap: Record<string, number> = { ...(badges || {}) };
  if (inboxUnread > 0 && badgeMap.inbox === undefined) badgeMap.inbox = inboxUnread;

  // Group items in original order — preserves the array's intent.
  const groups: { label: string; items: NavItem[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const item of navItems) {
    let idx = groupIndex.get(item.group);
    if (idx === undefined) {
      idx = groups.length;
      groupIndex.set(item.group, idx);
      groups.push({ label: item.group, items: [] });
    }
    groups[idx].items.push(item);
  }


  return (
    <aside
      id="sidebar-drawer"
      // Dialog semantics only matter on mobile (md:hidden in effect).
      // Desktop always renders the sidebar inline; aria-modal=false +
      // tabindex untouched there. The role+aria-modal attributes are
      // harmless on desktop since screen-readers treat the open state
      // as the gate.
      role={isMobileOpen ? "dialog" : undefined}
      aria-modal={isMobileOpen ? true : undefined}
      aria-label="Navigation menu"
      // Desktop collapse: when isDesktopCollapsed, slide the aside fully
      // off-screen. Mobile drawer transform takes priority on small
      // screens. CSS variable on <html> drives the main element's left
      // margin so the page expands smoothly.
      // The overlay shadow only while the drawer is OPEN: a closed drawer
      // sits at translateX(-100%) and its 32px blur would smear a dark band
      // down the left edge of every phone screen.
      className={`fixed left-0 top-0 bottom-0 w-60 bg-bg-rail flex flex-col z-40 md:z-20 transition-transform duration-150 max-md:border-r max-md:border-hairline ${
        isMobileOpen ? "translate-x-0 max-md:shadow-elev" : "-translate-x-full"
      } ${isDesktopCollapsed ? "md:-translate-x-full" : "md:translate-x-0"}`}
    >
      {sections ? (
        <OsRail
          sections={sections}
          brand={brand}
          logo={logo}
          operatorName={operatorName}
          operatorEmail={operatorEmail}
          isOperator={isOperator}
          primaryAgent={primaryAgent}
          primaryAgentLive={primaryAgentLive}
          bridgeOnline={bridgeOnline}
          statusKnown={statusKnown}
          badges={badgeMap}
          showConnections={showConnections}
          connectionsStatus={connectionsStatus}
          notifications={notifications}
          intentFor={intentFor}
          isMobileOpen={isMobileOpen}
          onMobileClose={onMobileClose}
          onDesktopCollapse={onDesktopCollapse}
        />
      ) : (
        <>
          {/* Brand block */}
          <div className="relative shrink-0 border-b border-hairline px-4 py-4">
            {/* Mobile-only close button. Sits over the brand block so the
                operator can dismiss the drawer without reaching for the
                outer backdrop. md+ never renders this. autoFocus is
                conditional on isMobileOpen so desktop renders don't yank
                focus away from whatever the operator is doing. */}
            {onMobileClose && (
              <button
                type="button"
                onClick={onMobileClose}
                aria-label="Close menu"
                autoFocus={isMobileOpen}
                className="md:hidden absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-dim hover:text-fg hover:bg-active-hover"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {/* Desktop-only collapse button — slides the sidebar off-screen.
                Floating reopen affordance lives in SidebarShell so it can
                render when the sidebar itself isn't visible. */}
            {onDesktopCollapse && (
              <button
                type="button"
                onClick={onDesktopCollapse}
                aria-label="Collapse navigation"
                className="hidden md:inline-flex absolute top-3 right-3 h-8 w-8 items-center justify-center rounded-lg text-fg-dim hover:text-fg hover:bg-active-hover transition-colors duration-150"
                title="Collapse sidebar (full-width view)"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            )}
            <Link href="/" prefetch={false} className="flex items-center gap-2.5 pr-8">
              <BrandMark logo={logo} brand={brand} />
              <div className="min-w-0 leading-tight">
                <div className="truncate text-sm font-semibold text-fg">{brand}</div>
                <div className="truncate text-xs text-fg-dim">{subtitle}</div>
              </div>
            </Link>
          </div>

          {/* Nav — min-h-0 is REQUIRED: a flex child won't scroll (overflow-y-auto
              is inert) unless it can shrink below its content height, so without it
              the full nav (OPERATIONS→SYSTEM) overflowed and the operator footer
              rendered on top of the lower groups on mobile (the 2026-06-30 "items
              folding on top of each other" report). */}
          <nav className="flex-1 min-h-0 px-2.5 py-3 overflow-y-auto overscroll-contain">
            {groups.map((g) => (
              <NavGroup key={g.label} label={g.label}>
                {g.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    isActive={item.href === bestMatchHref}
                    badgeCount={item.badgeKey ? badgeMap[item.badgeKey] || 0 : 0}
                    demoMode={demoMode}
                    demoLandingPath={demoLandingPath}
                    onIntent={item.href === "/web-leads" ? prefetchWebLeads : undefined}
                  />
                ))}
              </NavGroup>
            ))}
          </nav>

          {/* Viewer — shrink-0 so the footer keeps its full height and pins to the
              bottom while the nav above scrolls (never compressed by a tall nav).
              The agent/bridge dots are gone from this shell: they describe
              OASIS's own machinery and now live in the operator's Admin view
              (components/os/OsRail.tsx). Here they only ever read "off" anyway,
              because preview and demo shells force them off. */}
          <div className="shrink-0 space-y-2 border-t border-hairline px-2.5 py-2.5">
            {demoMode && (
              <div className="rounded-lg border border-hairline bg-bg-panel px-3 py-2 text-xs">
                <div className="font-medium text-fg">{demoLabel}</div>
                <Link href="/api/demo/clear" prefetch={false} className="mt-0.5 inline-block text-accent hover:underline">
                  Exit demo mode
                </Link>
              </div>
            )}
            <div className="flex items-center gap-2.5 px-1">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-bg-elev text-xs font-semibold text-fg-muted">
                {(operatorName || "U").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13px] font-medium text-fg">{operatorName || "Operator"}</div>
                <div className="truncate text-xs text-fg-dim">{operatorEmail || ""}</div>
              </div>
              <form action="/api/auth/signout" method="post">
                <button
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-dim transition-colors duration-150 hover:bg-active-hover hover:text-fg"
                >
                  <LogOut size={16} strokeWidth={1.75} aria-hidden />
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * Brand tile for the preview/demo shells. Flat: the old SunBiz and Suga marks
 * were gradient tiles with a blurred coloured halo, and the OASIS one wrapped
 * OasisLogo in a blue blur — three glows on the one element every screen shows.
 */
function BrandMark({ logo, brand }: { logo: "oasis" | "sunbiz" | "suga"; brand: string }) {
  if (logo === "sunbiz" || logo === "suga") {
    const Glyph = logo === "sunbiz" ? SunMedium : Crown;
    return (
      <div
        aria-hidden
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-bg-elev ${
          logo === "sunbiz" ? "text-amber-300" : "text-pink-300"
        }`}
      >
        <Glyph size={16} strokeWidth={1.75} />
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-hairline bg-bg-elev text-xs font-semibold text-fg-muted"
    >
      {logo === "oasis" ? (
        <Image src="/oasis-logo.jpg" alt="" width={32} height={32} className="h-full w-full object-cover" />
      ) : (
        (brand.trim().charAt(0) || "W").toUpperCase()
      )}
    </div>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      {/* Sentence-case 12.5px heading (was a 10px uppercase tracked label). */}
      <div className="mb-px flex h-7 items-center px-2.5 text-[12.5px] font-medium text-fg-dim">
        {label}
      </div>
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

function NavLink({
  item,
  isActive,
  badgeCount = 0,
  demoMode = false,
  demoLandingPath,
  onIntent,
}: {
  item: NavItem;
  isActive: boolean;
  badgeCount?: number;
  demoMode?: boolean;
  demoLandingPath?: string;
  onIntent?: () => void;
}) {
  const active = isActive;
  const Icon = iconFor(item.icon);
  const href = demoHref(item.href, { demoMode, landingPath: demoLandingPath });
  const router = useRouter();
  // Warm the route only when the operator SHOWS INTENT. Hover/focus fires
  // router.prefetch for this one destination, plus any data warm the parent
  // wired through onIntent.
  const warm = useCallback(() => {
    try {
      router.prefetch(href);
    } catch {
      // prefetch is best-effort; never let it break a click
    }
    onIntent?.();
  }, [router, href, onIntent]);
  return (
    <li>
      {/* ═══ PREFETCH IS OFF, AND THAT IS THE FIX ═══════════════════════════
          Every nav item is in the viewport, so ANY viewport-triggered
          prefetch fires once per link on every page load. Two rounds of
          production measurement, logged in, on /pipeline:

            forced prefetch:  /settings 1,389 ms, / 962 ms, /web-leads 916 ms,
                              /playbook 328 ms
            Next default:     /schedule 805 ms, /web-leads 790 ms,
                              /settings 762 ms, /playbook 748 ms

          The default was NOT meaningfully cheaper — routes without a loading
          boundary still render server-side to satisfy it, so ~3.1 s of work
          still fired for pages the operator never opened. Turning prefetch
          off and warming on hover/focus instead is what actually removes it,
          and a hover lands 150-300 ms before the click on a real pointer.
          The OS rail's links follow the same rule (components/os/RailRow.tsx). */}
      <Link
        href={href}
        prefetch={false}
        onMouseEnter={warm}
        onFocus={warm}
        aria-current={active ? "page" : undefined}
        // Neutral active row — no blue fill, no inset ring, no glow bar. The
        // accent is for actions, and a selected row is not one.
        className={`group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors duration-150 ${
          active ? "bg-active text-fg" : "text-fg-muted hover:bg-active-hover hover:text-fg"
        }`}
      >
        <Icon
          size={16}
          className={active ? "shrink-0 text-fg" : "shrink-0 text-fg-dim group-hover:text-fg-muted"}
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badgeCount > 0 && (
          <span
            className="ml-auto min-w-[18px] rounded-full bg-unread px-1.5 text-center text-[11px] font-semibold leading-[18px] text-white tabular-nums"
            title={`${badgeCount} unread`}
          >
            {badgeCount > 99 ? "99+" : badgeCount}
          </span>
        )}
        {item.expandable && badgeCount === 0 && (
          <ChevronRight size={12} className="text-fg-dim" />
        )}
      </Link>
    </li>
  );
}
