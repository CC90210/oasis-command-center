/**
 * Short-lived, per-tab request cache for the Web Leads browser.
 *
 * Next's route prefetch warms the page shell, but the expensive list and facet
 * reads happen after the client component mounts. Keeping those JSON requests
 * in one module lets Sidebar intent-prefetch and WebLeadsBrowser share the same
 * in-flight promise and the same brief successful result.
 *
 * This is deliberately memory-only. A claim changes who may work a lead, so a
 * durable cache would be the wrong tradeoff; successful claim/release paths
 * explicitly clear this map before the browser refreshes its queue.
 */

import { memorableQuery, readRememberedFilters } from "./filter-memory";
import { filtersToParams, parseFilters } from "./filters";

export const WEB_LEADS_CLIENT_CACHE_TTL_MS = 15_000;
const WEB_LEADS_CLIENT_CACHE_MAX_ENTRIES = 40;
// Keep requesting a server-cache bypass for longer than the 90s projected-row
// memo. Vercel can route two consecutive requests to different warm instances;
// refreshing only the instance that handled the mutation would otherwise let a
// later request resurrect pre-mutation ownership from a neighbour.
const WEB_LEADS_BROWSER_STALE_WINDOW_MS = 95_000;

type CacheEntry = {
  token: symbol;
  promise: Promise<unknown>;
  /** Infinity while the request is in flight; the TTL starts on success. */
  expiresAt: number;
};

const requestCache = new Map<string, CacheEntry>();
let reloadBrowserCacheUntil = 0;

function apiUrl(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function pruneRequestCache(now: number): void {
  for (const [key, entry] of requestCache) {
    if (entry.expiresAt !== Number.POSITIVE_INFINITY && entry.expiresAt <= now) {
      requestCache.delete(key);
    }
  }
  while (requestCache.size >= WEB_LEADS_CLIENT_CACHE_MAX_ENTRIES) {
    const oldestResolved = [...requestCache].find(
      ([, entry]) => entry.expiresAt !== Number.POSITIVE_INFINITY,
    );
    if (!oldestResolved) break;
    requestCache.delete(oldestResolved[0]);
  }
}

/** Build the exact canonical requests used by both prefetch and page render. */
export function webLeadsRequestUrls(search: string): { facets: string; list: string } {
  const filters = parseFilters(new URLSearchParams(search));
  const facetParams = filtersToParams({ ...filters, page: 1, leadId: null });
  const listParams = filtersToParams({ ...filters, leadId: null });
  if (filters.view === "mine") listParams.set("scope", "mine");
  else if (filters.view === "team") listParams.set("scope", "team");

  return {
    facets: apiUrl("/api/web-leads/facets", facetParams),
    list: apiUrl("/api/web-leads", listParams),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok ? "invalid_json_response" : `HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

/**
 * Deduplicate identical GETs and retain successful JSON briefly.
 *
 * Failed promises are removed only if they are still the current entry. That
 * identity check prevents an older rejection from deleting a newer retry that
 * was installed after an explicit invalidation.
 */
export function fetchCachedWebLeadsJson<T>(url: string): Promise<T> {
  const now = Date.now();
  const cached = requestCache.get(url);
  if (cached && cached.expiresAt > now) {
    // Refresh insertion order so the cap behaves as a small LRU, not FIFO.
    requestCache.delete(url);
    requestCache.set(url, cached);
    return cached.promise as Promise<T>;
  }
  if (cached) requestCache.delete(url);
  pruneRequestCache(now);

  const token = Symbol(url);
  const forceFresh = Date.now() < reloadBrowserCacheUntil;
  const requestUrl = forceFresh
    ? `${url}${url.includes("?") ? "&" : "?"}fresh=1`
    : url;
  const promise = fetch(requestUrl, {
    credentials: "same-origin",
    // Clearing our Map is not enough: the browser may still hold the private
    // max-age/SWR response. After an ownership mutation, reload through that
    // full HTTP stale window so the next queue cannot resurrect old ownership.
    cache: forceFresh ? "reload" : "default",
  })
    .then((response) => readJson<T>(response))
    .then((body) => {
      const current = requestCache.get(url);
      if (current?.token === token) {
        current.expiresAt = Date.now() + WEB_LEADS_CLIENT_CACHE_TTL_MS;
      }
      return body;
    });

  const entry: CacheEntry = { token, promise, expiresAt: Number.POSITIVE_INFINITY };
  requestCache.set(url, entry);
  void promise.catch(() => {
    if (requestCache.get(url)?.token === token) requestCache.delete(url);
  });
  return promise;
}

/** Ownership mutations invalidate lists and facets together. */
export function invalidateWebLeadsClientCache(): void {
  requestCache.clear();
  reloadBrowserCacheUntil = Date.now() + WEB_LEADS_BROWSER_STALE_WINDOW_MS;
}

/**
 * Best-effort speculative read. The list receipt carries its matching facets,
 * so one authenticated request warms the whole Leads screen.
 */
export async function prefetchWebLeads(search: string): Promise<void> {
  const urls = webLeadsRequestUrls(search);
  await Promise.allSettled([fetchCachedWebLeadsJson(urls.list)]);
}

/** Read and re-canonicalize filter memory at intent time, not at render time. */
export function prefetchRememberedWebLeads(): Promise<void> {
  return prefetchWebLeads(memorableQuery(readRememberedFilters()));
}
