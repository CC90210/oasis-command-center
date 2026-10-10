"use client";

/**
 * RailFooter — who is signed in, and the rail's utility doors: Settings
 * (gear) — which also carries the Connections attention signal, since
 * Settings > Connections is where that status lives — a notifications slot,
 * and, for platform operators only, the Admin shield, which switches the
 * rail to Admin rows without navigating.
 *
 * Connections had its own door (a plug) until 2026-10-10; the owners removed
 * it as a redundant second door into Settings and asked that the signal move
 * to the gear instead of being lost.
 *
 * The attention dot is drawn ONLY from a real status: app/layout.tsx sums
 * the statuses Settings > Connections shows (lib/os/connectors.ts
 * connectionsDot). Amber on the gear when any app needs the owner; no dot at
 * all when every app set up is proven connected, or when nothing has been
 * measured yet. There is no green "all healthy" dot — a reachable Settings
 * needs no badge to say it is fine; only a problem does.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { LogOut, Settings, Shield, type LucideIcon } from "lucide-react";
import { useWarmOnIntent } from "@/components/os/RailRow";

export type ConnectionsStatus = "ok" | "attention";

export function RailFooter({
  pathname,
  operatorName,
  operatorEmail,
  showConnections,
  connectionsStatus = null,
  notifications,
  isOperator,
  adminActive,
  onToggleAdmin,
}: {
  pathname: string;
  operatorName?: string;
  operatorEmail?: string;
  /** Workspace owners/admins manage connections; others never see the attention signal either. */
  showConnections: boolean;
  /** Null = not measured: no dot at all. */
  connectionsStatus?: ConnectionsStatus | null;
  /** Bell / inbox slot. Nothing renders until a real source fills it. */
  notifications?: ReactNode;
  isOperator: boolean;
  adminActive: boolean;
  onToggleAdmin: () => void;
}) {
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const needsAttention = showConnections && connectionsStatus === "attention";
  const name = operatorName || "Signed in";
  return (
    <div className="shrink-0 border-t border-hairline px-2.5 pb-2.5 pt-2">
      <div className="flex items-center gap-2.5 px-1 py-1">
        <div
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-bg-elev text-xs font-semibold text-fg-muted"
        >
          {name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-medium text-fg">{name}</div>
          {operatorEmail && <div className="truncate text-xs text-fg-dim">{operatorEmail}</div>}
        </div>
        <form action="/api/auth/signout" method="post">
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-dim outline-none transition-colors duration-150 hover:bg-active-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <LogOut size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </form>
      </div>
      <div className="mt-1 flex items-center gap-0.5">
        <FooterLink
          href="/settings"
          label={needsAttention ? "Settings: a connection needs attention" : "Settings"}
          icon={Settings}
          active={onSettings}
          dot={needsAttention}
        />
        {notifications}
        {isOperator && (
          <button
            type="button"
            onClick={onToggleAdmin}
            aria-pressed={adminActive}
            aria-label={adminActive ? "Leave Admin" : "Admin"}
            title={adminActive ? "Back to the workspace" : "Admin (OASIS operators)"}
            className={`ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/60 ${
              adminActive ? "bg-active text-fg" : "text-fg-dim hover:bg-active-hover hover:text-fg"
            }`}
          >
            <Shield size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function FooterLink({
  href,
  label,
  icon: Icon,
  active,
  dot = false,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** True draws the attention dot. There is no second colour: ok/unmeasured draw nothing. */
  dot?: boolean;
}) {
  const warm = useWarmOnIntent(href);
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={warm}
      onFocus={warm}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/60 ${
        active ? "bg-active text-fg" : "text-fg-dim hover:bg-active-hover hover:text-fg"
      }`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
      {dot && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-status-warm" />}
    </Link>
  );
}
