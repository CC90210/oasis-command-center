/**
 * lib/ai-audit/pagespeed.ts — Google PageSpeed Insights for the client's home
 * page, phone view: speed, accessibility, search basics and best practice
 * scores, and the timings behind them. A measurement we make, so its results
 * are Verified facts with the run itself as their source.
 *
 * Best effort and keyless by default: Google rate-limits keyless calls, so a
 * refusal or a timeout is a gap in the research ("PageSpeed could not be run"),
 * never a reason to stop. PAGESPEED_API_KEY, when set as a Worker secret, makes
 * it reliable; it is sent only to Google and never stored with the result.
 *
 * Only the home page's public address is sent, and only when it is a public
 * web address (lib/ai-audit/site-url.ts isFetchableUrl).
 */
import { isFetchableUrl } from "@/lib/ai-audit/site-url";

export const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const PAGESPEED_TIMEOUT_MS = 60_000;
/** The answer is large (a full Lighthouse report); only this much is read. */
export const PAGESPEED_MAX_BYTES = 4_000_000;

export type PageSpeedScores = { performance: number | null; accessibility: number | null; seo: number | null; best_practices: number | null };
export type PageSpeedTimings = { lcp_ms: number | null; fcp_ms: number | null; tbt_ms: number | null; cls: number | null; speed_index_ms: number | null };
export type PageSpeedResult =
  | { ok: true; url: string; final_url: string | null; strategy: "mobile"; scores: PageSpeedScores; timings: PageSpeedTimings; fetched_at: string; lighthouse_version: string | null }
  | { ok: false; url: string; error: "not_public" | "rate_limited" | "timeout" | "refused" | "unreadable" | "too_large"; detail: string };

export type PageSpeedFetch = (url: string, init: { method: "GET"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

function score(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 100) : null;
}
function ms(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Lighthouse's answer, read defensively: anything missing is null, never guessed. */
export function parsePageSpeed(url: string, body: unknown, fetchedAt: string): PageSpeedResult {
  const lh = (body as { lighthouseResult?: Record<string, unknown> } | null)?.lighthouseResult;
  if (!lh || typeof lh !== "object") return { ok: false, url, error: "unreadable", detail: "the answer held no Lighthouse report" };
  const cats = (lh.categories ?? {}) as Record<string, { score?: unknown }>;
  const audits = (lh.audits ?? {}) as Record<string, { numericValue?: unknown }>;
  const cls = audits["cumulative-layout-shift"]?.numericValue;
  // The panel links to it: only an http(s) address is kept (review of phase 3, F9: "javascript:..." was stored).
  const reported = typeof lh.finalDisplayedUrl === "string" ? lh.finalDisplayedUrl : typeof lh.finalUrl === "string" ? lh.finalUrl : null;
  return {
    ok: true,
    url,
    final_url: reported && /^https?:\/\//i.test(reported) ? reported.slice(0, 500) : null,
    strategy: "mobile",
    scores: {
      performance: score(cats.performance?.score),
      accessibility: score(cats.accessibility?.score),
      seo: score(cats.seo?.score),
      best_practices: score(cats["best-practices"]?.score),
    },
    timings: {
      lcp_ms: ms(audits["largest-contentful-paint"]?.numericValue),
      fcp_ms: ms(audits["first-contentful-paint"]?.numericValue),
      tbt_ms: ms(audits["total-blocking-time"]?.numericValue),
      cls: typeof cls === "number" && Number.isFinite(cls) && cls >= 0 ? Math.round(cls * 1000) / 1000 : null,
      speed_index_ms: ms(audits["speed-index"]?.numericValue),
    },
    fetched_at: fetchedAt,
    lighthouse_version: typeof lh.lighthouseVersion === "string" ? lh.lighthouseVersion.slice(0, 20) : null,
  };
}

/** One PageSpeed run for the home page. Never throws. */
export async function runPageSpeed(url: string, deps: { fetch: PageSpeedFetch; key?: string | null; now: () => Date; timeoutMs?: number }): Promise<PageSpeedResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, url, error: "not_public", detail: "not a web address" };
  }
  if (!isFetchableUrl(target)) return { ok: false, url, error: "not_public", detail: "not a public web address" };
  const q = new URLSearchParams({ url: target.toString(), strategy: "mobile" });
  for (const c of ["PERFORMANCE", "ACCESSIBILITY", "SEO", "BEST_PRACTICES"]) q.append("category", c);
  if (deps.key) q.set("key", deps.key);
  const ctrl = new AbortController();
  const timeoutMs = Math.min(PAGESPEED_TIMEOUT_MS, Math.max(1, deps.timeoutMs ?? PAGESPEED_TIMEOUT_MS));
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await deps.fetch(`${PAGESPEED_ENDPOINT}?${q.toString()}`, { method: "GET", signal: ctrl.signal, headers: { accept: "application/json" } });
    if (res.status === 429) return { ok: false, url, error: "rate_limited", detail: "Google asked us to slow down (no PageSpeed key is set)" };
    if (!res.ok) return { ok: false, url, error: "refused", detail: `PageSpeed answered HTTP ${res.status}` };
    const raw = await res.text();
    if (raw.length > PAGESPEED_MAX_BYTES) return { ok: false, url, error: "too_large", detail: "the report was larger than expected" };
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, url, error: "unreadable", detail: "the answer was not JSON" };
    }
    return parsePageSpeed(target.toString(), body, deps.now().toISOString());
  } catch (err) {
    const aborted = ctrl.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return { ok: false, url, error: aborted ? "timeout" : "refused", detail: aborted ? `PageSpeed did not answer within ${Math.ceil(timeoutMs / 1000)} seconds` : "PageSpeed could not be reached" };
  } finally {
    clearTimeout(timer);
  }
}
