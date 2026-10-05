"use client";

/**
 * ModeTabs — Team · Growth · Clients · Money, in the rail header (plan D1/D2:
 * no new top bar). Icon over an 11px label; the active mode is full-strength
 * text with a 2px underline, the rest are dim. No fill, no accent: the accent
 * is for actions.
 *
 * Each tab is a link to its mode's first row, so middle-click opens the mode in
 * a new tab and the address bar always names a real page. `onSelect` switches
 * the rail's rows immediately, before the navigation lands.
 *
 * Only the modes the viewer has are rendered — Money is absent, not greyed, for
 * anyone who is not an owner.
 */

import Link from "next/link";
import type { NavIconKey } from "@/lib/nav-config";
import type { OsSectionKey } from "@/lib/os/types";
import { iconFor, useWarmOnIntent } from "@/components/os/RailRow";

export type ModeTab = { key: OsSectionKey; label: string; icon: NavIconKey; home: string };

export function ModeTabs({
  modes,
  active,
  onSelect,
}: {
  modes: readonly ModeTab[];
  /** Null while the rail shows Admin rows: no mode is lit. */
  active: OsSectionKey | null;
  onSelect: (key: OsSectionKey) => void;
}) {
  return (
    <nav aria-label="Workspace modes" className="px-2">
      <ul className="grid auto-cols-fr grid-flow-col gap-0.5">
        {modes.map((mode) => (
          <ModeTabLink key={mode.key} mode={mode} active={mode.key === active} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  );
}

function ModeTabLink({
  mode,
  active,
  onSelect,
}: {
  mode: ModeTab;
  active: boolean;
  onSelect: (key: OsSectionKey) => void;
}) {
  const warm = useWarmOnIntent(mode.home);
  const Icon = iconFor(mode.icon);
  return (
    <li>
      <Link
        href={mode.home}
        prefetch={false}
        onMouseEnter={warm}
        onFocus={warm}
        onClick={() => onSelect(mode.key)}
        aria-current={active ? "true" : undefined}
        className={`relative flex flex-col items-center gap-1 rounded-lg pb-2 pt-1.5 text-[11px] font-medium leading-none outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/60 ${
          active ? "text-fg" : "text-fg-dim hover:bg-active-hover hover:text-fg-muted"
        }`}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden />
        <span>{mode.label}</span>
        {active && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-fg" />}
      </Link>
    </li>
  );
}
