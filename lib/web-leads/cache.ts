/**
 * cache.ts — a short-lived in-process memo for this feature's whole-table reads.
 *
 * ═══ THE PROBLEM ════════════════════════════════════════════════════════════
 *
 * Opening the Leads tab took 5-7 seconds. Not mysteriously: every single load
 * pulls FOUR whole tables across HTTP and then filters them in memory --
 *
 *   ~31,000 tenant_records rows, each carrying its full `data` JSON blob
 *   ~23,000 audit rows (twice: once for newest-per-business, once for scored)
 *    ~4,300 unreachable rows
 *
 * -- to render fifty. The in-memory filtering is not the cost; the transfer is.
 *
 * It cannot simply be pushed server-side. Territory, city and industry live
 * inside a JSON blob and are free text ("Québec", "Restaurants & Bars"), and
 * this feature's standing rule is that such values never enter a PostgREST
 * filter string. That rule is a real injection defence and is not being traded
 * away for latency.
 *
 * ═══ WHY A CACHE IS SAFE HERE SPECIFICALLY ══════════════════════════════════
 *
 * Caching a lead list would normally be alarming: a rep could see a lead in the
 * pool that somebody else already claimed. What makes it safe is that claiming
 * is a compare-and-swap (see claim-ops.ts). A stale pool cannot cause a
 * duplicate call -- it can only cause a claim that fails, and failing tells the
 * rep the truth: "these were taken by someone else just now." The cache can
 * therefore only ever cost a rep one wasted click, never a wasted phone call.
 *
 * That is the entire argument. If the swap is ever removed, this cache must go
 * with it, because the guarantee is the swap's and not this module's.
 *
 * Writes invalidate in-process immediately, so the rep who just claimed sees
 * their own change at once on that instance. Another serverless instance can
 * still hold up to TTL of staleness -- which is why the TTLs are seconds, and
 * why the swap, not the TTL, is what makes it correct.
 *
 * ═══ WHAT IS NOT CACHED ═════════════════════════════════════════════════════
 *
 * Single-lead reads (fetchLead) and every write path go straight to the
 * database. Authorization decisions are never served from here.
 */

type Entry<T> = { value: T; expires: number };

const store = new Map<string, Entry<unknown>>();

/**
 * Cache TTLs, in milliseconds.
 *
 * LEADS is deliberately short. It is the table ownership changes on, and a rep
 * watching a lead they just released linger for half a minute would reasonably
 * conclude the button is broken.
 *
 * SCORES is longer because it changes only when a scoring run writes, which is
 * a batch job measured in hours, not a per-request event.
 *
 * CORPUS backs lib/web-leads/competitors.ts and is deliberately NOT folded into
 * LEADS even though both derive from the same tenant_records scan. They answer
 * questions with different staleness budgets: the leads table must show a lead
 * returning to the pool within seconds of a rep releasing it, while a
 * percentile against 23,195 scored sites changes only when a scoring run
 * writes. One shared TTL would either re-transfer ~31,000 rows every ten
 * seconds to answer a question whose answer changes daily, or leave a released
 * lead on screen for five minutes.
 */
export const TTL = { LEADS: 10_000, SCORES: 300_000, CORPUS: 300_000 } as const;

/**
 * Run `load` and memoise it for `ttlMs`, keyed by `key`.
 *
 * IN-FLIGHT REQUESTS SHARE ONE LOAD. The promise goes into the map before it
 * resolves, so five reps opening the page in the same second trigger ONE
 * 31,000-row read rather than five. Without that, a cold instance under load
 * multiplies exactly the cost this module exists to remove.
 *
 * A REJECTED LOAD IS NEVER CACHED. The entry is dropped on failure, so a
 * transient bridge error cannot pin a broken read for the whole TTL -- which
 * would turn one bad second into ten of a feature that appears empty. Failing
 * loudly on the next request is correct; failing quietly for ten seconds is
 * not.
 */
export async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;

  const promise = load().catch((err) => {
    store.delete(key);
    throw err;
  });
  store.set(key, { value: promise, expires: now + ttlMs });
  return promise;
}

/**
 * Drop cached entries whose key starts with `prefix`.
 *
 * Called by every write path in this feature. It is deliberately blunt: after a
 * claim, re-reading one extra table is far cheaper than reasoning about which
 * derived views a single lead's ownership change invalidates, and getting that
 * reasoning subtly wrong is how a rep ends up staring at a lead they know they
 * released.
 */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
