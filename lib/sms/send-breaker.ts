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
import { getServiceSupabase } from "@/lib/supabase-server";
import { breakerVerdict, type BreakerVerdict } from "./carrier-status";
import { readRecentReceipts, newestOpenReceiptAt } from "./delivery-receipts";

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
  opts: {
    nowMs?: number;
    force?: boolean;
    /**
     * Which WIRE is being judged.
     *
     * The breaker was tenant-wide, and that broke the moment a tenant had two
     * independent TextTorrent accounts (2026-08-14). The main SunBiz SID is
     * sitting on 19 consecutive carrier failures; the new Legacy/AI account has
     * two unburned numbers and has never sent. A tenant-wide verdict halts the
     * second because of the first — so Live Subs would fall back to email
     * without either good number ever being tried, defeating the entire point
     * of standing the wire up. Caught by Codex in review.
     *
     * `wire` keys the cache. `onlyLines` / `excludeLines` scope the receipts.
     * Omit all three for the original tenant-wide behaviour.
     */
    wire?: string;
    onlyLines?: string[];
    excludeLines?: string[];
  } = {},
): Promise<BreakerVerdict> {
  if (disabled()) {
    return {
      halt: false,
      halfOpen: false,
      reason: "breaker disabled by SMS_BREAKER_DISABLED",
      consecutiveFailures: 0,
      failRatio: 0,
      sample: 0,
    };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const key = opts.wire ? `${tenantId}::${opts.wire}` : tenantId;
  const hit = cache.get(key);
  if (!opts.force && hit && nowMs - hit.at < CACHE_MS) return hit.verdict;

  const recent = await readRecentReceipts(tenantId, {
    sinceMs: nowMs - 24 * 3_600_000,
    onlyLines: opts.onlyLines,
    excludeLines: opts.excludeLines,
  });
  const newestOpenAt = await newestOpenReceiptAt(tenantId);
  const verdict = breakerVerdict(recent, { nowMs, newestOpenAt });
  cache.set(key, { at: nowMs, verdict });
  return verdict;
}

/** Drop the cached verdict — used after a reconcile run so a recovery is picked
 *  up immediately rather than up to a minute later.
 *
 *  Clears EVERY wire for the tenant, since verdicts are now keyed per wire and
 *  a reconcile can move any of them. Missing one would leave a recovered wire
 *  halted for up to a minute for no reason. */
export function resetBreakerCache(tenantId?: string): void {
  if (!tenantId) return cache.clear();
  cache.delete(tenantId);
  for (const k of cache.keys()) if (k.startsWith(`${tenantId}::`)) cache.delete(k);
}

/** How long a claimed probe blocks the next one. Matches the breaker's own
 *  probe interval so the lease and the verdict agree. */
const PROBE_LEASE_MS = 30 * 60_000;

/**
 * Try to claim the one half-open probe.
 *
 * Returns true for EXACTLY ONE caller per interval, across every process.
 *
 * The in-process cache cannot provide that. Dispatch runs concurrently on
 * Vercel (cron plus external pingers), so each instance would independently see
 * "probe due", clear only its own cache, and send — the one-probe guarantee was
 * a comment, not a mechanism. The conditional UPDATE below is the mechanism:
 * Postgres serialises writers on the row, so only the caller that observes the
 * stale timestamp gets a row back.
 *
 * FAILS CLOSED. Any error means we did not claim it, so the probe simply does
 * not go out this cycle and the next run tries again.
 */
export async function claimBreakerProbe(tenantId: string, nowMs = Date.now()): Promise<boolean> {
  const db = getServiceSupabase();
  const cutoff = new Date(nowMs - PROBE_LEASE_MS).toISOString();
  try {
    // Make sure the row exists. ignoreDuplicates so a concurrent creator does
    // not overwrite a lease that was just claimed.
    const seed = await db
      .from("sms_breaker_probes")
      .upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true });
    if (seed.error) return false;

    const claim = await db
      .from("sms_breaker_probes")
      .update({ last_probe_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() })
      .eq("tenant_id", tenantId)
      .lt("last_probe_at", cutoff)
      .select("tenant_id");
    if (claim.error) return false;
    return (claim.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
