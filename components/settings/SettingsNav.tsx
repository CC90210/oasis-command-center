"use client";

/**
 * SettingsNav — the section list on the left of every Settings page.
 *
 * Inside the page, not in the rail: the rail stays the product's navigation and
 * Settings keeps its own index, as in the design (doc 01 §(a) "SETTINGS").
 * The server passes only the sections this viewer may open
 * (visibleSettingsSections), so there is nothing to hide here.
 *
 * Rows follow the rail's anatomy: 32px, neutral active fill, no blue. Below
 * `lg` the list becomes a horizontal strip that scrolls on its own, so a phone
 * never scrolls the page sideways.
 *
 * Links keep prefetch off, like the rail: eleven sections prefetched on every
 * Settings visit would be eleven server renders nobody asked for. Instead a
 * section is warmed when the viewer shows intent (hover / keyboard focus), the
 * rail's own useWarmOnIntent, so it starts loading 150-300 ms before the click.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Brain,
  CreditCard,
  MessagesSquare,
  MonitorSmartphone,
  Palette,
  Plug,
  ScrollText,
  ShieldCheck,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { SettingsSectionDef, SettingsSectionKey } from "@/components/settings/settings-sections";
import { useWarmOnIntent } from "@/components/os/RailRow";

const ICONS: Record<SettingsSectionKey, LucideIcon> = {
  profile: UserRound,
  team: UsersRound,
  connections: Plug,
  "chat-apps": MessagesSquare,
  ai: Brain,
  brand: Palette,
  billing: CreditCard,
  notifications: Bell,
  privacy: ShieldCheck,
  "audit-log": ScrollText,
  devices: MonitorSmartphone,
};

/** Longest matching section href wins, so /settings/team is not also "Profile". */
function activeHref(pathname: string, sections: readonly SettingsSectionDef[]): string | null {
  let best: string | null = null;
  for (const s of sections) {
    const hit = pathname === s.href || pathname.startsWith(`${s.href}/`);
    if (hit && (!best || s.href.length > best.length)) best = s.href;
  }
  return best;
}

export function SettingsNav({ sections }: { sections: readonly SettingsSectionDef[] }) {
  const pathname = usePathname() || "/settings";
  const active = activeHref(pathname, sections);
  return (
    <nav aria-label="Settings sections" className="lg:sticky lg:top-6 lg:self-start">
      <h2 className="mb-2 hidden px-2.5 text-xs font-medium text-fg-dim lg:block">Settings</h2>
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0">
        {sections.map((s) => (
          <SettingsNavRow key={s.key} section={s} isActive={s.href === active} />
        ))}
      </ul>
    </nav>
  );
}

/** One section link, warmed on hover or keyboard focus. */
function SettingsNavRow({ section: s, isActive }: { section: SettingsSectionDef; isActive: boolean }) {
  const Icon = ICONS[s.key];
  const warm = useWarmOnIntent(s.href);
  return (
    <li className="shrink-0">
      <Link
        href={s.href}
        prefetch={false}
        onMouseEnter={warm}
        onFocus={warm}
        aria-current={isActive ? "page" : undefined}
        className={`flex h-8 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium transition-colors duration-150
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70
          ${isActive ? "bg-active text-fg" : "text-fg-muted hover:bg-active-hover hover:text-fg"}`}
      >
        <Icon aria-hidden className={`h-4 w-4 shrink-0 ${isActive ? "text-fg" : "text-fg-dim"}`} strokeWidth={1.75} />
        {s.label}
      </Link>
    </li>
  );
}
