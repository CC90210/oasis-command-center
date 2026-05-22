"use client";

/**
 * usePlanMode — shared state hook for the Plan/Execute switch.
 *
 * Both ChatWidget (main /agents page) and AgentChat (tenant-preview at
 * /t/[slug]/agent/[agent]) need identical plan-mode behavior: an in-
 * memory "plan" | "build" toggle, hydrated from sessionStorage on
 * mount, persisted on every change. Before this hook the two surfaces
 * carried near-identical copies of:
 *
 *   const [planMode, setPlanModeState] = useState<...>("build");
 *   useEffect(() => { ... read from sessionStorage ... }, []);
 *   const setPlanMode = (next) => { setPlanModeState; sessionStorage.setItem; };
 *
 * Centralizing here means one source of truth for the persistence
 * contract. Sibling chat surfaces that ship later (e.g., the embedded
 * dashboard widget on tenant pages) inherit the same behavior with a
 * one-line call.
 *
 * Storage keys are per-surface (not shared) so the operator's plan
 * mode in the main chat doesn't leak into the tenant preview. Pass the
 * key explicitly — typo-safe constants live in the hook's call sites,
 * not here, because a shared "the one true key" would couple the
 * lifetimes of unrelated surfaces.
 */

import { useEffect, useState } from "react";

export type PlanMode = "plan" | "build";

export function usePlanMode(storageKey: string): readonly [PlanMode, (next: PlanMode) => void] {
  const [mode, setModeState] = useState<PlanMode>("build");

  // Hydrate from sessionStorage on mount. Safe to run after SSR: the
  // first paint shows the "build" default, then this effect upgrades
  // to "plan" if a prior call persisted that value.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved === "plan" || saved === "build") setModeState(saved);
    } catch {
      // sessionStorage unavailable (privacy mode, exotic browser) — fall
      // back to in-memory default.
    }
  }, [storageKey]);

  function setMode(next: PlanMode) {
    setModeState(next);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(storageKey, next);
      } catch {
        // sessionStorage quota / privacy mode — non-fatal, state is
        // still tracked in memory.
      }
    }
  }

  return [mode, setMode] as const;
}
