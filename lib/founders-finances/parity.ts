/**
 * 50/50 owner parity view. PURE.
 *
 * CC and Adon own OASIS equally. Parity is about what each has TAKEN OUT net
 * of what each has PUT IN: net withdrawn = draws - contributions. The owner
 * who has withdrawn less is "behind" by the difference, and taking that much
 * (or the other contributing it back) restores 50/50. Amounts are CAD
 * equivalents at each event's own-day rate.
 */

import type { OwnerKey } from "./access";

export type EquityEvent = { ownerKey: OwnerKey; kind: "draw" | "contribution"; cadCents: number };

export type OwnerTotals = { drawsCents: number; contributionsCents: number; netWithdrawnCents: number };

export type Parity = {
  cc: OwnerTotals;
  adon: OwnerTotals;
  differenceCents: number;
  behind: OwnerKey | null;
  equalizingCents: number;
};

export function ownerParity(events: readonly EquityEvent[]): Parity {
  const t: Record<OwnerKey, OwnerTotals> = {
    cc: { drawsCents: 0, contributionsCents: 0, netWithdrawnCents: 0 },
    adon: { drawsCents: 0, contributionsCents: 0, netWithdrawnCents: 0 },
  };
  for (const e of events) {
    const row = t[e.ownerKey];
    if (!row) continue;
    if (e.kind === "draw") row.drawsCents += e.cadCents;
    else row.contributionsCents += e.cadCents;
  }
  for (const k of ["cc", "adon"] as const) t[k].netWithdrawnCents = t[k].drawsCents - t[k].contributionsCents;
  const differenceCents = t.cc.netWithdrawnCents - t.adon.netWithdrawnCents;
  return {
    cc: t.cc,
    adon: t.adon,
    differenceCents,
    behind: differenceCents > 0 ? "adon" : differenceCents < 0 ? "cc" : null,
    equalizingCents: Math.abs(differenceCents),
  };
}
