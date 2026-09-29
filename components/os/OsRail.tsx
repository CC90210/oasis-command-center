"use client";

/**
 * OsRail — the OASIS OS navigation rail (plan W2; design doc §(a), §(d)).
 *
 *   ┌ Workspace name                      [collapse]
 *   │ Team · Growth · Clients · Money        ← ModeTabs (only the modes you have)
 *   │ rows for the active mode, in sentence-case collapsible groups
 *   └ you · sign out / Settings · Connections · [notifications] · [Admin shield]
 *
 * The content is DATA computed on the server by lib/os/nav.ts buildOsNav — this
 * component decides nothing about who may see what. It decides only which of
 * the viewer's own sections is on screen:
 *
 *   active mode = the section owning the longest-prefix match of the pathname
 *                 across every row, else the last mode this tab used
 *                 (sessionStorage), else the first section.
 *
 * It renders INSIDE components/Sidebar.tsx's <aside>, which keeps the fixed
 * positioning, the collapse transform, the mobile drawer and the
 * SIDEBAR_BOOT_SCRIPT / html[data-sidebar] contract exactly as they were.
 */

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PanelLeftClose, X } from "lucide-react";
import { longestPrefixMatch } from "@/lib/os/match";
import type { OsNavRow, OsNavSection, OsSectionKey } from "@/lib/os/types";
import { activeRailMode, lastNormalMode, modeToRemember } from "@/components/os/rail-mode";
import { ModeTabs } from "@/components/os/ModeTabs";
import { RailGroup } from "@/components/os/RailGroup";
import { RailRow, useWarmOnIntent } from "@/components/os/RailRow";
import { RailFooter, type ConnectionsStatus } from "@/components/os/RailFooter";

const MODE_STORAGE_KEY = "oasis.os.rail-mode.v1";

export type OsRailProps = {
  sections: readonly OsNavSection[];
  brand: string;
  logo: "oasis" | "sunbiz" | "suga";
  operatorName?: string;
  operatorEmail?: string;
  /** Shows the Admin shield (and only the server-built Admin rows exist). */
  isOperator: boolean;
  /** Admin view status line. Operators only; never shown elsewhere. */
  primaryAgent: string;
  primaryAgentLive: boolean;
  bridgeOnline: boolean;
  /** False until the deferred /api/shell/status read answers: render "—". */
  statusKnown: boolean;
  /** Needs-you counts keyed by OsNavRow.badgeKey. Absent key = no pill. */
  badges?: Record<string, number>;
  showConnections: boolean;
  connectionsStatus?: ConnectionsStatus | null;
  notifications?: ReactNode;
  /** Extra data warm for a row's hover/focus (e.g. the Prospects list). */
  intentFor?: (href: string) => (() => void) | undefined;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  onDesktopCollapse?: () => void;
};

type LocatedRow = OsNavRow & { section: OsSectionKey };

export function OsRail({
  sections,
  brand,
  logo,
  operatorName,
  operatorEmail,
  isOperator,
  primaryAgent,
  primaryAgentLive,
  bridgeOnline,
  statusKnown,
  badges,
  showConnections,
  connectionsStatus = null,
  notifications,
  intentFor,
  isMobileOpen = false,
  onMobileClose,
  onDesktopCollapse,
}: OsRailProps) {
  const pathname = usePathname() || "/";

  const rows = useMemo<LocatedRow[]>(
    () => sections.flatMap((s) => s.groups.flatMap((g) => g.rows.map((r) => ({ ...r, section: s.key })))),
    [sections],
  );
  const available = useMemo(() => sections.map((s) => s.key), [sections]);

  const matched = longestPrefixMatch(pathname, rows);
  const pathMode = matched?.section ?? null;
  const modes = sections.filter((s) => s.key !== "admin");

  // A tab click or the shield overrides the path until the path changes.
  const [manual, setManual] = useState<OsSectionKey | null>(null);
  useEffect(() => {
    setManual(null);
  }, [pathname]);

  // Last mode used in this browser tab, for pages no row owns (/settings, …)
  // and for leaving Admin. Read after mount so the server render and hydration
  // agree; kept current below (rail-mode.ts modeToRemember).
  const [remembered, setRemembered] = useState<OsSectionKey | null>(null);
  const [storageRead, setStorageRead] = useState(false);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(MODE_STORAGE_KEY) as OsSectionKey | null;
      if (raw) setRemembered(raw);
    } catch {
      // Blocked storage: fall back to the first mode.
    }
    setStorageRead(true);
  }, []);

  const activeMode = activeRailMode({ manual, pathMode, remembered, available });

  useEffect(() => {
    const mode = modeToRemember(activeMode, storageRead);
    if (!mode) return;
    setRemembered(mode);
    try {
      window.sessionStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Convenience only.
    }
  }, [activeMode, storageRead]);

  const adminView = activeMode === "admin";
  const shown = sections.find((s) => s.key === activeMode) ?? null;

  const toggleAdmin = () => {
    setManual(adminView ? lastNormalMode({ remembered, available }) : "admin");
  };

  const warmHome = useWarmOnIntent("/");

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 px-2.5 pt-1">
        <Link
          href="/"
          prefetch={false}
          onMouseEnter={warmHome}
          onFocus={warmHome}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 outline-none transition-colors duration-150 hover:bg-active-hover focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <RailBrandMark logo={logo} brand={brand} />
          <span className="truncate text-sm font-semibold text-fg">{brand}</span>
        </Link>
        {onMobileClose && (
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            autoFocus={isMobileOpen}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-dim hover:bg-active-hover hover:text-fg md:hidden"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {onDesktopCollapse && (
          <button
            type="button"
            onClick={onDesktopCollapse}
            aria-label="Collapse navigation"
            title="Collapse sidebar (full-width view)"
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-dim transition-colors duration-150 hover:bg-active-hover hover:text-fg md:inline-flex"
          >
            <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>

      {modes.length > 1 && (
        <div className="mb-2 mt-1 shrink-0">
          <ModeTabs
            modes={modes.map((m) => ({ key: m.key, label: m.label, icon: m.icon, home: m.home }))}
            active={adminView ? null : activeMode}
            onSelect={setManual}
          />
        </div>
      )}

      {/* min-h-0 is REQUIRED: a flex child will not scroll unless it can shrink
          below its content, and without it the footer rode up over the lower
          rows on mobile (the 2026-06-30 "items folding on top of each other"). */}
      <nav
        aria-label={shown ? `${shown.label} navigation` : "Navigation"}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3"
      >
        {adminView && (
          <>
            <div className="flex h-7 items-center px-2.5 text-[12.5px] font-medium text-fg-dim">
              Admin · OASIS operators
            </div>
            <OperatorStatus
              primaryAgent={primaryAgent}
              primaryAgentLive={primaryAgentLive}
              bridgeOnline={bridgeOnline}
              known={statusKnown}
            />
          </>
        )}
        {shown?.groups.map((group) => (
          <RailGroup key={group.id} id={group.id} label={group.label}>
            {group.rows.map((row) => (
              <RailRow
                key={row.id}
                href={row.href}
                label={row.label}
                icon={row.icon}
                active={matched?.id === row.id}
                badge={row.badgeKey ? badges?.[row.badgeKey] ?? 0 : 0}
                onIntent={intentFor?.(row.href)}
              />
            ))}
          </RailGroup>
        ))}
      </nav>

      <RailFooter
        pathname={pathname}
        operatorName={operatorName}
        operatorEmail={operatorEmail}
        showConnections={showConnections}
        connectionsStatus={connectionsStatus}
        notifications={notifications}
        isOperator={isOperator && sections.some((s) => s.key === "admin")}
        adminActive={adminView}
        onToggleAdmin={toggleAdmin}
      />
    </>
  );
}

/**
 * The workspace mark. The OASIS image is drawn directly rather than through
 * components/brand/OasisLogo, which still carries a cyan halo shadow; any other
 * workspace gets a flat monogram tile, never an invented logo.
 */
function RailBrandMark({ logo, brand }: { logo: "oasis" | "sunbiz" | "suga"; brand: string }) {
  if (logo === "oasis") {
    return (
      <Image
        src="/oasis-logo.jpg"
        alt=""
        width={22}
        height={22}
        className="h-[22px] w-[22px] shrink-0 rounded-md object-cover ring-1 ring-hairline"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border border-hairline bg-bg-elev text-[11px] font-semibold text-fg-muted"
    >
      {(brand.trim().charAt(0) || "W").toUpperCase()}
    </span>
  );
}

/**
 * The agent heartbeat and local-bridge dots, moved out of every viewer's rail
 * into the operator's Admin view (they describe OASIS's own machinery). Static
 * dots — no pulse: a perpetual animation costs a compositor layer for the whole
 * session and says nothing a colour does not. Before the deferred status read
 * answers, both read "—", not "idle": an unasked question has no answer yet.
 */
function OperatorStatus({
  primaryAgent,
  primaryAgentLive,
  bridgeOnline,
  known,
}: {
  primaryAgent: string;
  primaryAgentLive: boolean;
  bridgeOnline: boolean;
  known: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-2.5 text-xs text-fg-dim">
      <StatusDot
        label={primaryAgent}
        state={!known ? null : primaryAgentLive}
        onText="live"
        offText="idle"
        title={
          !known
            ? "Checking the agent heartbeat"
            : primaryAgentLive
              ? `${primaryAgent} ticked in the last 15 min`
              : `${primaryAgent} hasn't ticked recently`
        }
      />
      <StatusDot
        label="bridge"
        state={!known ? null : bridgeOnline}
        onText="online"
        offText="offline"
        title={
          !known
            ? "Checking the local bridge"
            : bridgeOnline
              ? "Local bridge daemon pinged within last 5 min"
              : "Local bridge offline — pair a machine from Settings → Devices"
        }
      />
    </div>
  );
}

function StatusDot({
  label,
  state,
  onText,
  offText,
  title,
}: {
  label: string;
  state: boolean | null;
  onText: string;
  offText: string;
  title: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={title}>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          state === null ? "bg-fg-faint" : state ? "bg-status-engaged" : "bg-fg-dim"
        }`}
      />
      <span className="truncate">{label}</span>
      <span className={state ? "text-status-engaged" : undefined}>
        {state === null ? "—" : state ? onText : offText}
      </span>
    </span>
  );
}
