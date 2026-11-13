/**
 * lib/site-scan/browser-read.ts - reading a site through the runner's real browser when the
 * Worker's own read was turned away.
 *
 * WHY (CC, 2026-11-13). The free scan read mandymanagement.com and got HTTP 403, and
 * mountainelectric.ca's robots.txt never answered, so both reports came back empty. From an
 * ordinary connection both sites answer in under half a second, with our own user agent too:
 * their hosts block or stall requests that come from Cloudflare's network, where the Worker runs.
 *
 * HOW. The runner is only a fetcher here. It opens each address in Chromium on its own network and
 * posts what the address answered (POST /api/internal/tools/scan-pages). readSite then runs over
 * those answers exactly as it runs over the Worker's own requests (robots.txt rules, the pages it
 * picks from the home page, every check), through replayRead. An address readSite asks for that the
 * runner has not sent is collected and asked for in the next round, so the planner lives in one
 * place. A site whose robots.txt closes it to us is still never read: that is "not_allowed", which
 * is not handed to the browser.
 */
import type { SiteReadDeps } from "@/lib/ai-audit/site-fetch";
import { MAX_PAGE_BYTES } from "@/lib/ai-audit/site-fetch";

/** The Worker's read outcomes a real browser may succeed at: no answer, refused, or a bot check. */
export const BROWSER_READ_UNREAD = ["no_answer", "home_page_failed", "not_the_site"] as const;
/** Addresses one browser read may carry (robots.txt per origin, the home page, http, sitemaps, eight pages, their redirects). */
export const MAX_BROWSER_PAGES = 32;
/** Rounds of "these addresses too" before the read is taken as it stands. */
export const MAX_BROWSER_ROUNDS = 4;
const MAX_URL = 2_048;
const MAX_MS = 60_000;

export type BrowserPage = { url: string; status: number; location: string | null; contentType: string; body: string; ms: number };

export function wantsBrowserRead(unread: string | null | undefined): boolean {
  return !!unread && (BROWSER_READ_UNREAD as readonly string[]).includes(unread);
}

/** Fewer readable words than this, over every page read, is a page a browser has yet to draw. */
export const THIN_WORDS = 60;

/**
 * A read that reached the site but found almost nothing on it: under THIN_WORDS words, or too
 * little to score. Live 2026-11-13: mrrooter.ca and bettys.co.uk came back as one page with no
 * name and no score, where a browser sees a full site.
 */
export function isThinRead(facts: { site: { unread: string | null } ; signals: { word_count: number } | null }, score: { total: number | null }): boolean {
  return !facts.site.unread && ((facts.signals?.word_count ?? 0) < THIN_WORDS || score.total === null);
}

/** Whether the runner reads this scan's site in its browser before it matches. */
export function needsBrowserRead(site: { unread: string | null; thin?: boolean } | null | undefined): boolean {
  return !!site && (wantsBrowserRead(site.unread) || site.thin === true);
}

/** One address as a key: absolute, no fragment. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** The runner's answers, checked field by field; an address it sent twice keeps the first. */
export function parseBrowserPages(raw: unknown): { ok: true; pages: BrowserPage[] } | { ok: false; field: string } {
  if (!Array.isArray(raw) || raw.length > MAX_BROWSER_PAGES) return { ok: false, field: "pages" };
  const seen = new Set<string>();
  const pages: BrowserPage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, field: "pages" };
    const o = item as Record<string, unknown>;
    const url = typeof o.url === "string" && o.url.length <= MAX_URL ? pageKey(o.url) : null;
    if (!url) return { ok: false, field: "pages.url" };
    const status = typeof o.status === "number" && Number.isInteger(o.status) && o.status >= 200 && o.status <= 599 ? o.status : null;
    if (status === null) return { ok: false, field: "pages.status" };
    const location = o.location == null ? null : typeof o.location === "string" && o.location.length <= MAX_URL ? o.location : undefined;
    if (location === undefined) return { ok: false, field: "pages.location" };
    const contentType = o.content_type == null ? "" : typeof o.content_type === "string" && o.content_type.length <= 200 ? o.content_type : null;
    if (contentType === null) return { ok: false, field: "pages.content_type" };
    const body = o.body == null ? "" : typeof o.body === "string" && o.body.length <= MAX_PAGE_BYTES ? o.body : null;
    if (body === null) return { ok: false, field: "pages.body" };
    const ms = typeof o.ms === "number" && Number.isFinite(o.ms) && o.ms >= 0 ? Math.min(o.ms, MAX_MS) : 0;
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push({ url, status, location, contentType, body, ms });
  }
  return { ok: true, pages };
}

/**
 * readSite's dependencies over the runner's answers. Each address answers as the browser saw it
 * (a redirect with its location, else the page), and the clock moves by the time the browser took,
 * so response times and the read's time budget mean what they mean for the Worker. An address that
 * was not sent fails as unreachable and is listed in `missing`.
 */
export function replayRead(pages: BrowserPage[], start = 0): { deps: Pick<SiteReadDeps, "fetch" | "clock">; missing: Set<string> } {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const missing = new Set<string>();
  let now = start;
  return {
    missing,
    deps: {
      clock: () => now,
      fetch: async (url) => {
        const key = pageKey(url);
        const page = key ? byUrl.get(key) : undefined;
        if (!page || !key) {
          if (key) missing.add(key);
          throw new Error("not read by the browser");
        }
        now += page.ms;
        const redirect = page.status >= 300 && page.status < 400;
        const headers: Record<string, string> = {};
        if (page.contentType) headers["content-type"] = page.contentType;
        if (redirect && page.location) headers.location = page.location;
        // A redirect, 204 or 304 carries no body (the Response constructor refuses one).
        const empty = redirect || page.status === 204 || page.status === 205 || page.status === 304;
        return new Response(empty ? null : page.body, { status: page.status, headers });
      },
    },
  };
}
