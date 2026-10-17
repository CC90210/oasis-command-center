/**
 * lib/founders-finances/stripe-sync-status.ts — "is Stripe connected?"
 * answered with a time, never a bare "Connected". PURE.
 *
 * A pinned account and a registered webhook say nothing about whether the
 * books are current: on 2026-09-29 the webhook was healthy and had received
 * nothing since 09-24, and nothing scheduled the reconcile. So where Finance
 * or Today reports Stripe, it says when the books last heard from Stripe: the
 * newest webhook event or the newest completed reconcile
 * (stripe-ingest.ts lastStripeSync). "Never synced" when neither exists. A
 * sync older than two days is flagged: the daily reconcile
 * (/api/cron/finance-books?job=stripe-reconcile) should have run since.
 */

import { timeAgo } from "@/lib/devices/presence";

export type StripeSyncLine = {
  /** live: synced within STALE_AFTER_MS; stale: older; never: no event and no reconcile ever. */
  state: "live" | "stale" | "never";
  note: string;
};

/** A daily job, with a day's grace for a missed run. */
export const STRIPE_SYNC_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export function stripeSyncLine(lastSyncAt: string | null, nowMs: number): StripeSyncLine {
  const ms = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  if (!Number.isFinite(ms)) return { state: "never", note: "Never synced" };
  const note = `Last synced ${timeAgo(ms, { now: nowMs })}`;
  return { state: nowMs - ms > STRIPE_SYNC_STALE_AFTER_MS ? "stale" : "live", note };
}
