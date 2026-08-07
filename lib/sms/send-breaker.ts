/**
 * lib/sms/send-breaker.ts — stop sending when the carrier is refusing everything.
 *
 * The 2026-07-27 outage ran for ten days and 51 consecutive failed sends. Every
 * one was billed. Nothing stopped, because nothing was watching the only signal
 * that mattered. This is the stop.
 *
 * The breaker reads closed receipts (see delivery-receipts.ts) and answers one
 * question: is the route delivering? A halt RESCHEDULES the affected drip step
 * rather than failing it, so no merchant is dropped from a sequence — we simply
 * stop paying to shout into a void until someone fixes the route.
 *
 * Rules are pure and live in carrier-status.ts; this file is the I/O and the
 * cache.
 */

import "server-only";
import { breakerVerdict, type BreakerVerdict } from "./carrier-status";
import { readRecentReceipts } from "./delivery-receipts";

/**
 * Re-reading the receipt window per drip row would issue one query per send.
 * The verdict changes on the scale of minutes, so a short cache is honest and
 * keeps a 200-row dispatch batch at one read.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; verdict: BreakerVerdict }>();

/** Escape hatch for a deliberate override while a vendor issue is open. Set
 *  SMS_BREAKER_DISABLED=1 to keep sending through a known-bad route. */
function disabled(): boolean {
  return process.env.SMS_BREAKER_DISABLED === "1";
}

/**
 * Should this tenant keep sending SMS right now?
 *
 * Fails CLOSED: an unreadable receipt history halts, because a breaker that
 * cannot see is not a breaker. An EMPTY history does not halt — a tenant that
 * has never sent must still be able to start.
 */
export async function smsSendAllowed(
  tenantId: string,
  opts: { nowMs?: number; force?: boolean } = {},
): Promise<BreakerVerdict> {
  if (disabled()) {
    return {
      halt: false,
      reason: "breaker disabled by SMS_BREAKER_DISABLED",
      consecutiveFailures: 0,
      failRatio: 0,
      sample: 0,
    };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const hit = cache.get(tenantId);
  if (!opts.force && hit && nowMs - hit.at < CACHE_MS) return hit.verdict;

  const recent = await readRecentReceipts(tenantId, { sinceMs: nowMs - 24 * 3_600_000, limit: 100 });
  const verdict = breakerVerdict(recent);
  cache.set(tenantId, { at: nowMs, verdict });
  return verdict;
}

/** Drop the cached verdict — used after a reconcile run so a recovery is picked
 *  up immediately rather than up to a minute later. */
export function resetBreakerCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}
