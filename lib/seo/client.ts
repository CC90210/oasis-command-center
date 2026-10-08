/**
 * Typed client for the oasis-seo-measure /v1 API.
 *
 * Takes any object with fetch(Request), so a Cloudflare service binding, a test fake or
 * another product's binding all work. Two outcomes besides data:
 *   SeoApiError    the Worker understood and said no (400 bad input, 404 unknown site)
 *   SeoUnavailable the data could not be read (no binding/key, refused key, Worker or DB
 *                  down, timeout, an answer that is not the API's shape)
 * The screen turns SeoUnavailable into a banner. Nothing here ever returns an empty
 * result in place of a failed read, and nothing here logs: callers log the reason only.
 */
import { SEO_RANGES, type AccessResult, type AddSiteResult, type SeoRange, type SiteSummary, type SitesList, type TopRows } from "./types";

export interface Fetcher {
  fetch(input: Request): Promise<Response>;
}

export class SeoUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`SEO data unavailable: ${reason}`);
    this.name = "SeoUnavailable";
  }
}

export class SeoApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "SeoApiError";
  }
}

/** Same rule as the Worker's route pattern and the tenants.tenant_id CHECK. */
export const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const SEO_TIMEOUT_MS = 8_000;
// check-access does a token exchange plus up to 4 Google calls, which outruns the 8s default
// used for every other call; give it its own longer budget (M1, 2026-10-07).
export const SEO_CHECK_ACCESS_TIMEOUT_MS = 20_000;
const MIN_KEY = 32;
// A service binding ignores the host; it only has to be a valid URL.
const ORIGIN = "https://oasis-seo-measure.internal";

type Opts = { fetcher: Fetcher; readKey: string; manageKey?: string | null; timeoutMs?: number; checkAccessTimeoutMs?: number };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createSeoClient(opts: Opts) {
  const timeoutMs = opts.timeoutMs ?? SEO_TIMEOUT_MS;
  const checkAccessTimeoutMs = opts.checkAccessTimeoutMs ?? SEO_CHECK_ACCESS_TIMEOUT_MS;

  async function call(method: "GET" | "POST", path: string, key: string, body?: unknown, msOverride?: number): Promise<{ status: number; json: Record<string, unknown> }> {
    const ms = msOverride ?? timeoutMs;
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    // One deadline covers the request AND the body read: a Worker that sends headers
    // then stalls the body must time out too. On expiry the request is aborted.
    const abort = new AbortController();
    const req = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new SeoUnavailable("timeout")); }, ms);
    });
    let res: Response;
    let parsed: unknown;
    try {
      try {
        res = await Promise.race([opts.fetcher.fetch(req), deadline]);
      } catch (e) {
        throw e instanceof SeoUnavailable ? e : new SeoUnavailable("unreachable");
      }
      try {
        parsed = await Promise.race([res.json(), deadline]);
      } catch (e) {
        if (e instanceof SeoUnavailable) { res.body?.cancel().catch(() => undefined); throw e; }
        throw new SeoUnavailable(`bad_response_${res.status}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!isObj(parsed)) throw new SeoUnavailable(`bad_response_${res.status}`);
    if (res.ok || res.status === 409) return { status: res.status, json: parsed };
    const code = typeof parsed.code === "string" ? parsed.code : "unknown";
    if (res.status === 400) throw new SeoApiError(400, code, typeof parsed.error === "string" ? parsed.error : "Invalid request");
    if (res.status === 404 && code === "unknown_site") throw new SeoApiError(404, code, "unknown site");
    // 401/403: our key is wrong or not allowed. 404 not_found: an old Worker. 5xx: Worker or DB down.
    throw new SeoUnavailable(`${res.status}_${code}`);
  }

  const siteId = (id: string) => {
    if (typeof id !== "string" || !SITE_ID_RE.test(id)) throw new SeoApiError(404, "unknown_site", "unknown site");
    return id;
  };
  const query = (range: SeoRange, includeTest?: boolean) => {
    if (!SEO_RANGES.includes(range)) throw new SeoApiError(400, "bad_range", `range must be one of ${SEO_RANGES.join(", ")}`);
    return `?range=${range}${includeTest ? "&include_test=1" : ""}`;
  };
  const manage = () => {
    if (!opts.manageKey) throw new SeoUnavailable("manage_key_missing");
    return opts.manageKey;
  };
  const shape = <T>(ok: boolean, v: Record<string, unknown>): T => {
    if (!ok) throw new SeoUnavailable("bad_shape");
    return v as T;
  };
  const isTop = (j: Record<string, unknown>) => isObj(j.site) && (j.rows === null || Array.isArray(j.rows));

  return {
    async listSites({ includeTest = false }: { includeTest?: boolean } = {}): Promise<SitesList> {
      const { json } = await call("GET", `/v1/sites${includeTest ? "?include_test=1" : ""}`, opts.readKey);
      return shape<SitesList>(Array.isArray(json.sites), json);
    },
    async summary(id: string, range: SeoRange, { includeTest = false }: { includeTest?: boolean } = {}): Promise<SiteSummary> {
      const path = `/v1/sites/${siteId(id)}/summary${query(range, includeTest)}`;
      const { json } = await call("GET", path, opts.readKey);
      return shape<SiteSummary>(isObj(json.site) && Array.isArray(json.trend) && isObj(json.freshness), json);
    },
    async queries(id: string, range: SeoRange, { includeTest = false }: { includeTest?: boolean } = {}): Promise<TopRows> {
      const { json } = await call("GET", `/v1/sites/${siteId(id)}/queries${query(range, includeTest)}`, opts.readKey);
      return shape<TopRows>(isTop(json), json);
    },
    async pages(id: string, range: SeoRange, { includeTest = false }: { includeTest?: boolean } = {}): Promise<TopRows> {
      const { json } = await call("GET", `/v1/sites/${siteId(id)}/pages${query(range, includeTest)}`, opts.readKey);
      return shape<TopRows>(isTop(json), json);
    },
    async addSite({ domain, dpaConfirmedBy, isTest = false }: { domain: string; dpaConfirmedBy: string; isTest?: boolean }): Promise<AddSiteResult> {
      const key = manage();
      const { status, json } = await call("POST", "/v1/sites", key, { domain, dpa_confirmed_by: dpaConfirmedBy, is_test: isTest });
      if (!isObj(json.site)) throw new SeoUnavailable("bad_shape");
      return status === 409 ? { created: false, site: json.site as AddSiteResult["site"] } : (json as AddSiteResult);
    },
    async checkAccess(id: string, actor: string): Promise<AccessResult> {
      const path = `/v1/sites/${siteId(id)}/check-access`;
      const { json } = await call("POST", path, manage(), { actor }, checkAccessTimeoutMs);
      return shape<AccessResult>(json.result === "ok" || json.result === "blocked" || json.result === "failed", json);
    },
  };
}

export type SeoClient = ReturnType<typeof createSeoClient>;

/** Build a client from a Worker env. Fails closed: no binding or no read key = unavailable. */
export function clientFromEnv(env: Record<string, unknown>): SeoClient {
  const binding = env.SEO_MEASURE as Fetcher | undefined;
  if (!binding || typeof binding.fetch !== "function") throw new SeoUnavailable("binding_missing");
  const readKey = env.SEO_READ_TOKEN;
  if (typeof readKey !== "string" || readKey.length < MIN_KEY) throw new SeoUnavailable("read_key_missing");
  const m = env.SEO_MANAGE_TOKEN;
  const manageKey = typeof m === "string" && m.length >= MIN_KEY ? m : null;
  // Keep the binding as the receiver: a detached fetch loses it.
  return createSeoClient({ fetcher: { fetch: (req) => binding.fetch(req) }, readKey, manageKey });
}

export type Loaded<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string } | { state: "not_found" };

/** Run a read and fold every failure into a state the page can draw. Logs the reason only. */
export async function settle<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { state: "ok", data: await fn() };
  } catch (e) {
    if (e instanceof SeoApiError && e.status === 404) return { state: "not_found" };
    const reason = e instanceof SeoUnavailable ? e.reason : e instanceof SeoApiError ? `${e.status}_${e.code}` : "error";
    // The reason only: never a URL, key, search term or row.
    console.error(JSON.stringify({ seo_unavailable: reason }));
    return { state: "unavailable", reason };
  }
}
