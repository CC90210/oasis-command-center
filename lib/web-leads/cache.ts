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
 *
 * ═══ LEADS: 10s -> 90s, 2026-08-26 ══════════════════════════════════════════
 *
 * THE OPERATOR COMPLAINT THIS FIXES (Adon): "when you click it for the first
 * time it takes over 10 seconds", and "when we change the preference in terms
 * of province or industry ... it takes a significant amount of time".
 *
 * The second half was this constant. Measured against live production
 * 2026-08-26, the projected lead read is 2,703 ms for 31,086 rows / 15.27 MB.
 * At a 10-second TTL, a rep who spends more than ten seconds reading the screen
 * before touching a filter pays that 2,703 ms AGAIN -- and reading the screen is
 * the entire job. So the common case was a cache that had already expired by the
 * time it was next needed. It was doing the work of a cache without the benefit
 * of one.
 *
 * WHY 90 SECONDS IS SAFE, and it is the SAME argument the module header makes:
 * claiming is a compare-and-swap (claim-ops.ts). A stale pool cannot produce a
 * duplicate call. It can only produce a claim that FAILS, and failing tells the
 * rep the truth -- "taken by someone else just now". The ceiling on staleness is
 * therefore one wasted CLICK, never a wasted phone call, at 10 seconds or at 90.
 *
 * WHY NOT LONGER: the release case is the one a human actually watches. A rep
 * who releases a lead and does not see it return to the pool concludes the
 * button is broken. Writes invalidate in-process immediately (invalidate()
 * below), so the rep who acted sees their own change AT ONCE on that instance;
 * 90s bounds only what a DIFFERENT serverless instance can still be showing.
 * That is a bound on someone else's screen, not on the actor's.
 *
 * THIS DOES NOT FIX THE COLD FIRST CLICK. A cold serverless instance has an
 * empty map and pays every read regardless of TTL. That is a separate problem
 * with a separate fix (server-side filtering and paging), and raising this
 * number must not be mistaken for having solved it.
 *
 * ═══ PARKED: its own TTL, 2026-08-26 ════════════════════════════════════════
 *
 * The parked-domain read is the most expensive query on this page PER ROW
 * RETURNED by an enormous margin. Measured live 2026-08-26:
 *
 *   parked net (business_id, signals)   2,125 ms   57 rows   0.07 MB
 *
 * Two seconds to move seventy kilobytes. The cost is not transfer, it is the
 * SCAN: sixteen `LIKE '%...%'` patterns over the `signals` blob of all 23,222
 * audit rows. A leading-wildcard LIKE cannot use an index, so this is a full
 * table scan by construction and no index will fix it.
 *
 * It was folded into loadScoreIndex(), so it was re-paid on every SCORES
 * rebuild -- every five minutes, per instance -- to recompute an answer that
 * changes only when the audit worker writes a new row. Given its own longer TTL
 * it is paid roughly once per half hour instead, taking ~2.1s off five of every
 * six score-index rebuilds.
 *
 * THE DURABLE FIX IS A STORED COLUMN, NOT A LONGER TTL. `is_parked` computed
 * once at audit-write time and indexed turns this into a point lookup and
 * removes the scan from a cold start too, which no TTL can do. That needs a
 * migration plus a JARVIS audit-worker change and is deliberately NOT bundled
 * here.
 */
export const TTL = { LEADS: 90_000, SCORES: 300_000, CORPUS: 300_000, PARKED: 1_800_000 } as const;

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
