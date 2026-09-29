/**
 * components/os/rail-mode.ts — which of the viewer's own sections the OS rail
 * shows, and which one it returns to when the Admin shield is switched off.
 *
 * PURE, type imports only: OsRail is a client component, and
 * tests/os-nav.test.ts runs these rules in bare node.
 *
 *   active mode = a tab click or the shield, until the path changes
 *               → else the section owning the pathname
 *               → else the last normal mode this tab used
 *
 * "The last normal mode used" has to stay current for the whole life of the
 * rail, not just its first render. It was read from sessionStorage once, on
 * mount, so a tab opened in Team that then moved to Growth still went back to
 * Team when Admin closed (CodeRabbit, PR #468).
 */
import type { OsSectionKey } from "@/lib/os/types";

export type RailModeInput = {
  /** A mode tab or the Admin shield, until the pathname changes. */
  manual: OsSectionKey | null;
  /** The section owning the longest-prefix match of the pathname. */
  pathMode: OsSectionKey | null;
  /** The last non-Admin mode this browser tab used. */
  remembered: OsSectionKey | null;
  /** The viewer's sections, in rail order. */
  available: readonly OsSectionKey[];
};

const has = (available: readonly OsSectionKey[], key: OsSectionKey | null): key is OsSectionKey =>
  !!key && available.includes(key);

/** Where leaving Admin goes: the remembered mode if the viewer still has it, else the first mode. */
export function lastNormalMode(input: Pick<RailModeInput, "remembered" | "available">): OsSectionKey | null {
  const { remembered, available } = input;
  if (has(available, remembered) && remembered !== "admin") return remembered;
  return available.find((k) => k !== "admin") ?? available[0] ?? null;
}

export function activeRailMode(input: RailModeInput): OsSectionKey | null {
  if (has(input.available, input.manual)) return input.manual;
  if (has(input.available, input.pathMode)) return input.pathMode;
  return lastNormalMode(input);
}

/**
 * The mode to remember after `active` rendered, or null to leave the memory
 * as it is. Admin is never remembered. Nothing is remembered before the stored
 * value has been read: the first render falls back to the first mode, and
 * remembering THAT would overwrite the mode the tab actually used last.
 */
export function modeToRemember(active: OsSectionKey | null, storageRead: boolean): OsSectionKey | null {
  if (!storageRead || !active || active === "admin") return null;
  return active;
}
