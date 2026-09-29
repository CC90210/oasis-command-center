"use client";

/**
 * RailRow — one destination in the OASIS OS rail, plus the two primitives
 * every rail link shares: the icon map and warm-on-intent.
 *
 * PREFETCH IS OFF ON EVERY RAIL LINK, AND THAT IS DELIBERATE. Every row is in
 * the viewport, so viewport prefetch fires once per row on every page load;
 * measured on production it cost ~3 s of server work for pages nobody opened
 * (the numbers are in components/Sidebar.tsx and tests/perf-prefetch.test.ts).
 * Hover/focus warms the one route the operator is heading for instead, which
 * lands 150-300 ms before the click. tests/os-nav.test.ts pins this for every
 * file under components/os/ that renders a <Link>.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import {
  Activity,
  BadgeDollarSign,
  BarChart3,
  BookOpen,
  BookUser,
  Bot,
  Brain,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Code2,
  Cpu,
  DollarSign,
  FileCode2,
  FileSearch,
  FileText,
  FolderKanban,
  GitBranch,
  GraduationCap,
  HandCoins,
  Handshake,
  Hash,
  Heart,
  HeartPulse,
  History,
  Home,
  Inbox,
  Landmark,
  LayoutDashboard,
  Library,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageSquare,
  PhoneCall,
  Plug,
  Radio,
  RefreshCcw,
  Rss,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  SquareTerminal,
  Ticket,
  TrendingUp,
  Upload,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { NavIconKey } from "@/lib/nav-config";

/**
 * NavIconKey → component. Nav data crosses the server → client boundary as
 * string keys (a function prop crashes production rendering), and this is the
 * one place a key becomes an icon. Typed as a total Record, so adding a key to
 * NavIconKey without an icon here is a type error rather than a blank glyph.
 */
export const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
  Activity,
  BadgeDollarSign,
  BarChart3,
  BookOpen,
  BookUser,
  Bot,
  Brain,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Code2,
  Cpu,
  DollarSign,
  FileCode2,
  FileSearch,
  FileText,
  FolderKanban,
  GitBranch,
  GraduationCap,
  HandCoins,
  Handshake,
  Hash,
  Heart,
  HeartPulse,
  History,
  Home,
  Inbox,
  Landmark,
  LayoutDashboard,
  Library,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageSquare,
  PhoneCall,
  Plug,
  Radio,
  RefreshCcw,
  Rss,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  SquareTerminal,
  Ticket,
  TrendingUp,
  Upload,
  Users,
  UsersRound,
  Wallet,
};

export function iconFor(key: NavIconKey): LucideIcon {
  return NAV_ICONS[key] || LayoutDashboard;
}

/**
 * Warm a route when the viewer shows intent (hover / keyboard focus). Also
 * runs `onIntent` — the rail passes the web-leads data warm through here so
 * the Prospects list is cached before the click lands.
 */
export function useWarmOnIntent(href: string, onIntent?: () => void): () => void {
  const router = useRouter();
  return useCallback(() => {
    try {
      router.prefetch(href);
    } catch {
      // Prefetch is best-effort; it must never break a click.
    }
    onIntent?.();
  }, [router, href, onIntent]);
}

/** 99+ caps the pill so a runaway count cannot widen the rail. */
export function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function RailRow({
  href,
  label,
  icon,
  active,
  badge = 0,
  onIntent,
}: {
  href: string;
  label: string;
  icon: NavIconKey;
  active: boolean;
  /** Needs-you count. 0 or absent renders nothing — an unknown count is not 0. */
  badge?: number;
  onIntent?: () => void;
}) {
  const warm = useWarmOnIntent(href, onIntent);
  const Icon = iconFor(icon);
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        onMouseEnter={warm}
        onFocus={warm}
        aria-current={active ? "page" : undefined}
        className={`group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/60 ${
          active ? "bg-active text-fg" : "text-fg-muted hover:bg-active-hover hover:text-fg"
        }`}
      >
        <Icon
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={active ? "shrink-0 text-fg" : "shrink-0 text-fg-dim group-hover:text-fg-muted"}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge > 0 && (
          <span
            className="ml-auto min-w-[18px] rounded-full bg-unread px-1.5 text-center text-[11px] font-semibold leading-[18px] text-white tabular-nums"
            aria-label={`${badge} need${badge === 1 ? "s" : ""} you`}
          >
            {formatCount(badge)}
          </span>
        )}
      </Link>
    </li>
  );
}
