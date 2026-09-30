/**
 * components/os/department/money-rules.ts — the Finance tab's MRR tile.
 *
 * PURE, so tests/os-stripe-sync.test.ts runs it in bare node (./numbers.ts is
 * server-only and reads the database).
 *
 * MRR is the books' copy of Stripe's subscriptions (metrics.ts stripeMrr reads
 * fin_subscriptions), which only the webhook and the daily reconcile keep
 * current. So the tile is "live" only while that sync is: a sync older than
 * two days, or one whose time could not be read, is "error"; one never made is
 * "no_data" (the same states as Today's Stripe line, model.ts
 * stripeConnection). The amount then moves into the hint: still visible, never
 * printed as a current figure (KpiTile prints `value` only when live).
 */

import type { KpiTileProps } from "@/components/os/KpiTile";
import { formatMoney } from "@/lib/fmt";
import { stripeSyncLine } from "@/lib/founders-finances/stripe-sync-status";

export type MrrRead = { mrr_cents: number; currency: string; active_subscriptions: number };
export type StripeSyncRead = { ok: true; lastSyncAt: string | null } | { ok: false };

export function mrrTile(mrr: MrrRead, sync: StripeSyncRead, nowMs: number): KpiTileProps {
  const amount = `${mrr.currency.toUpperCase() === "CAD" ? "CA" : ""}${formatMoney(mrr.mrr_cents / 100)}`;
  const subs = `${mrr.active_subscriptions.toLocaleString("en-US")} live Stripe subscription${mrr.active_subscriptions === 1 ? "" : "s"}`;
  // A pinned account is not a synced one: say when Stripe last reached the books.
  const line = sync.ok ? stripeSyncLine(sync.lastSyncAt, nowMs) : null;
  if (line?.state === "live") return { label: "MRR", value: amount, status: "live", hint: `${subs} · ${line.note}` };
  if (line?.state === "never") return { label: "MRR", value: null, status: "no_data", emptyText: line.note, hint: `${amount} from ${subs}` };
  return { label: "MRR", value: null, status: "error", hint: `${amount} from ${subs} · ${line ? line.note : "Stripe sync: couldn't check"}` };
}
