/**
 * lib/os/modules.ts — which modules a workspace has.
 *
 * INTERIM, AND FAIL-CLOSED ON PURPOSE. The durable source is a
 * `tenant_entitlements` table that only operators and the verified billing
 * webhook can write (plan D7): access = bought ∩ manifest ∩ persona. It does not
 * exist yet, and the manifest cannot stand in for it because a tenant can edit
 * its own manifest (app/api/manifest/[slug]/route.ts). So until it lands:
 *
 *   OASIS's own workspaces  → the `internal` tier (everything OASIS runs today)
 *   every other workspace   → no modules. Core rows (Today, Pipeline, Forms,
 *                             departments…) still render; nothing that has to
 *                             be bought does.
 *   unprovisioned           → no modules, and buildOsNav shows Today only.
 *
 * A module missing from a client's rail is a sales conversation. A module
 * present that the client never bought is a billing dispute — or, for finance,
 * a client owner reading OASIS's ledger (fin_* is not tenant-scoped yet).
 */

import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import type { ModuleKey } from "@/lib/os/types";

export const ALL_MODULES: readonly ModuleKey[] = [
  "finance",
  "commissions",
  "legal",
  "content",
  "research",
  "ads",
  "meetings",
  "enablement",
  "prospects",
  "portal",
];

/**
 * Module sets per tier. `diy` / `setup` / `managed` are placeholders until Atlas
 * validates the offer; only `internal` and `none` are reachable from
 * resolveOsModules today.
 */
export const TIER_MODULES: Readonly<Record<"internal" | "none", readonly ModuleKey[]>> = {
  // OASIS dogfoods everything it sells, plus the OASIS-only prospecting and
  // enablement surfaces its reps use daily. Finance stays here because the
  // finances tool is keyed to fin_ent_oasis until fin_* is re-tenanted.
  internal: ["finance", "commissions", "enablement", "prospects", "content", "ads"],
  none: [],
};

export function resolveOsModules(input: {
  tenantSlug: string | null | undefined;
  provisioned: boolean;
}): readonly ModuleKey[] {
  if (!input.provisioned) return TIER_MODULES.none;
  return isOasisSurfaceTenant(input.tenantSlug) ? TIER_MODULES.internal : TIER_MODULES.none;
}
