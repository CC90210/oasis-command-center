"use client";

/**
 * RailFooter — who is signed in, and the rail's utility doors: a human
 * Settings door (person icon) — which also carries the Connections
 * attention signal, since Settings > Connections is where that status lives
 * — a notifications slot, and an AI door (Bot icon). Two visually distinct
 * doors so a client is never confused about which "settings" they are
 * opening (2026-10-10): a person for their own account, a robot for the AI.
 *
 * The AI door is two different things wearing one icon:
 *   - a platform operator gets a console TOGGLE, exactly as the Admin shield
 *     it replaced did — it switches the rail to Admin/AI-console rows
 *     without navigating, never a link.
 *   - anyone else who may open Settings > AI brain (mayOpenAiSettings —
 *     app/layout.tsx computes it with the SAME predicate the page's own gate
 *     uses, maySeeSettingsSection(access, "ai") / requireSettingsSection)
 *     gets a plain link to /settings/ai instead.
 *   - anyone who may not: no door at all. Never a button that leads to a
 *     refusal.
 * When the link form is active, the person door gives up "active" on that
 * path — only one door is ever active at once.
 *
 * Connections had its own door (a plug) until 2026-10-10; the owners removed
 * it as a redundant second door into Settings and asked that the signal move
 * to the person door instead of being lost. The Admin shield was replaced
 * the same day for the mirror-image reason: a shield and a gear both read as
 * generic "settings," with nothing to tell a client which is which.
 *
 * The attention dot is drawn ONLY from a real status: app/layout.tsx sums
 * the statuses Settings > Connections shows (lib/os/connectors.ts
 * connectionsDot). Amber on the person door when any app needs the owner; no
 * dot at all when every app set up is proven connected, or when nothing has
 * been measured yet. There is no green "all healthy" dot — a reachable
 * Settings needs no badge to say it is fine; only a problem does.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Bot, LogOut, UserRound, type LucideIcon } from "lucide-react";
import { useWarmOnIntent } from "@/components/os/RailRow";

export type ConnectionsStatus = "ok" | "attention";

export function RailFooter({
  pathname,
  operatorName,
  operatorEmail,
  showConnections,
  connectionsStatus = null,
  mayOpenAiSettings = false,
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
  /** maySeeSettingsSection(access, "ai"): the AI door for a NON-operator. An
   *  operator always gets the console toggle instead, regardless of this. */
  mayOpenAiSettings?: boolean;
  /** Bell / inbox slot. Nothing renders until a real source fills it. */
  notifications?: ReactNode;
  isOperator: boolean;
  adminActive: boolean;
  onToggleAdmin: () => void;
}) {
  const onAi = pathname === "/settings/ai" || pathname.startsWith("/settings/ai/");
  // The AI door is a real link only for a non-operator; an operator's Bot
  // toggles the rail's own rows and never claims a path of its own.
  const aiIsLink = !isOperator && mayOpenAiSettings;
  const onSettings = (pathname === "/settings" || pathname.startsWith("/settings/")) && !(aiIsLink && onAi);
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
          icon={UserRound}
          active={onSettings}
          dot={needsAttention}
        />
        {notifications}
        {isOperator ? (
          <button
            type="button"
            onClick={onToggleAdmin}
            aria-pressed={adminActive}
            aria-label={adminActive ? "Leave AI console" : "AI console"}
            title={adminActive ? "Back to the workspace" : "AI console (OASIS operators)"}
            className={`ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/60 ${
              adminActive ? "bg-active text-fg" : "text-fg-dim hover:bg-active-hover hover:text-fg"
            }`}
          >
            <Bot size={16} strokeWidth={1.75} aria-hidden />
          </button>
        ) : (
          mayOpenAiSettings && (
            <FooterLink href="/settings/ai" label="AI settings" icon={Bot} active={onAi} className="ml-auto" />
          )
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
  className = "",
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** True draws the attention dot. There is no second colour: ok/unmeasured draw nothing. */
  dot?: boolean;
  /** Extra classes, e.g. "ml-auto" to pin a second door to the far edge. */
  className?: string;
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
      } ${className}`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
      {dot && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-status-warm" />}
    </Link>
  );
}
