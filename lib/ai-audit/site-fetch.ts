/**
 * lib/ai-audit/site-fetch.ts — read a business's own website for the
 * pre-call brief: the home page, up to eight of its pages that matter to a
 * service business (contact, booking, services, pricing, about), robots.txt
 * and the sitemap. Then run the checks (site-checks.ts) over what was read.
 *
 * How it fetches, every time:
 *   - only addresses lib/ai-audit/site-url.ts allows (public names, default
 *     ports, no credentials), checked again on every redirect hop, at most 5;
 *   - an honest user agent that says who is reading and why;
 *   - robots.txt's rules for everyone are followed for every page after the
 *     home page (the client asked for the audit; the home page is what any
 *     visitor sees);
 *   - each response read up to MAX_PAGE_BYTES, each request stopped after
 *     PAGE_TIMEOUT_MS, the whole read stopped after TOTAL_BUDGET_MS;
 *   - nothing is sent but a plain GET, never a cookie or a login.
 *
 * The fetch itself is passed in, so tests run on fixtures without a network.
 */
import { isFetchableUrl, onSameSite, type SiteTarget } from "@/lib/ai-audit/site-url";
import { pagesToRead, readRobots, robotsAllow, runSiteChecks, type PageSnapshot, type SiteCheck } from "@/lib/ai-audit/site-checks";

export const MAX_PAGE_BYTES = 600_000;
export const PAGE_TIMEOUT_MS = 8_000;
export const TOTAL_BUDGET_MS = 25_000;
export const MAX_REDIRECTS = 5;
export const MAX_EXTRA_PAGES = 8;
export const USER_AGENT = "OASIS-AI-Audit/1.0 (+https://oasisai.work; reads public pages for an AI audit the business asked for)";

export type FetchLike = (url: string, init: { method: "GET"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export type SiteReadDeps = { fetch: FetchLike; clock: () => number };

/** One page as read: what the brief stores (a hash and an excerpt), never the page itself. */
export type PageRecord = {
  url: string;
  finalUrl: string | null;
  status: number | null;
  bytes: number;
  ms: number;
  title: string | null;
  /** Why it could not be read, when it could not. */
  error: string | null;
  html: string | null;
};

export type SiteReport = {
  start: string;
  pages: PageRecord[];
  checks: SiteCheck[];
  /** Pages skipped or not read, in words for the brief's gaps. */
  notes: string[];
};

type Read = { ok: true; page: PageSnapshot } | { ok: false; error: string; finalUrl: string | null; status: number | null };

async function readBody(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(all), bytes, truncated };
}

/** GET one address, following redirects one hop at a time, each hop checked. */
export async function readPage(url: string, deps: SiteReadDeps, opts: { accept: "html" | "text"; deadline: number }): Promise<Read> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return { ok: false, error: "bad_address", finalUrl: current, status: null };
    }
    if (!isFetchableUrl(u)) return { ok: false, error: hop ? "redirected_off_the_public_web" : "not_public", finalUrl: u.toString(), status: null };
    const left = opts.deadline - deps.clock();
    if (left <= 0) return { ok: false, error: "out_of_time", finalUrl: u.toString(), status: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(PAGE_TIMEOUT_MS, left));
    const started = deps.clock();
    try {
      const res = await deps.fetch(u.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: opts.accept === "html" ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" : "text/plain,*/*;q=0.5" },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel().catch(() => undefined);
        current = new URL(location, u).toString();
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (opts.accept === "html" && contentType && !/text\/html|application\/xhtml/.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: "not_a_web_page", finalUrl: u.toString(), status: res.status };
      }
      const body = await readBody(res, MAX_PAGE_BYTES);
      return {
        ok: true,
        page: { url, finalUrl: u.toString(), status: res.status, contentType, html: body.text, bytes: body.bytes, ms: deps.clock() - started, truncated: body.truncated },
      };
    } catch (err) {
      return { ok: false, error: controller.signal.aborted ? "timed_out" : `unreachable${err instanceof Error && /certificate|tls|ssl/i.test(err.message) ? "_tls" : ""}`, finalUrl: u.toString(), status: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "too_many_redirects", finalUrl: current, status: null };
}

function titleOf(html: string): string | null {
  const lower = html.toLowerCase();
  const i = lower.indexOf("<title");
  if (i === -1) return null;
  const open = lower.indexOf(">", i);
  const close = open === -1 ? -1 : lower.indexOf("</title", open);
  if (open === -1 || close === -1 || close - open > 1_000) return null;
  const t = html.slice(open + 1, close).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : null;
}

const ERROR_WORDS: Readonly<Record<string, string>> = {
  not_public: "is not a public website address",
  redirected_off_the_public_web: "redirected to an address that is not a public website, so it was not followed",
  out_of_time: "was not read: the time for reading the site ran out",
  timed_out: "did not answer within 8 seconds",
  unreachable: "could not be reached",
  unreachable_tls: "could not be reached over a secure connection (a certificate problem)",
  not_a_web_page: "is not a web page",
  too_many_redirects: "redirected more than 5 times",
  bad_address: "is not a valid address",
};

export function describeReadError(url: string, error: string): string {
  return `${url} ${ERROR_WORDS[error] ?? `could not be read (${error})`}.`;
}

/** Read the site and run the checks. Never throws for a bad site: what failed goes in `notes`. */
export async function readSite(target: Extract<SiteTarget, { kind: "site" }>, deps: SiteReadDeps): Promise<SiteReport> {
  const deadline = deps.clock() + TOTAL_BUDGET_MS;
  const pages: PageRecord[] = [];
  const notes: string[] = [];
  const record = (url: string, r: Read) => {
    pages.push(
      r.ok
        ? { url, finalUrl: r.page.finalUrl, status: r.page.status, bytes: r.page.bytes, ms: r.page.ms, title: titleOf(r.page.html), error: null, html: r.page.html }
        : { url, finalUrl: r.finalUrl, status: r.status, bytes: 0, ms: 0, title: null, error: r.error, html: null },
    );
  };

  // The home page, over HTTPS first. A site that answers only on plain HTTP is read there, and that is a finding.
  let home = await readPage(target.start, deps, { accept: "html", deadline });
  let served = home.ok && home.page.finalUrl.startsWith("https:");
  if (!home.ok && target.start.startsWith("https:") && /^unreachable/.test(home.error)) {
    const plain = target.start.replace(/^https:/, "http:");
    const viaHttp = await readPage(plain, deps, { accept: "html", deadline });
    if (viaHttp.ok) {
      notes.push(describeReadError(target.start, home.error));
      home = viaHttp;
      served = viaHttp.page.finalUrl.startsWith("https:");
    }
  }
  record(target.start, home);
  if (!home.ok) {
    notes.push(describeReadError(target.start, home.error));
    return { start: target.start, pages, checks: runSiteChecks({ pages: [], https: { served: false, httpRedirects: null }, sitemap: null }), notes };
  }
  if (home.page.status < 200 || home.page.status >= 300) notes.push(`${target.start} answered with HTTP ${home.page.status}.`);

  // Does plain http:// send visitors to the secure address?
  let httpRedirects: boolean | null = null;
  if (served) {
    const plain = target.start.replace(/^https:/, "http:");
    const r = await readPage(plain, deps, { accept: "html", deadline });
    httpRedirects = r.ok ? r.page.finalUrl.startsWith("https:") : null;
  }

  // robots.txt: the sitemap's address, and the paths closed to everyone.
  const robotsUrl = new URL("/robots.txt", home.page.finalUrl).toString();
  const robots = await readPage(robotsUrl, deps, { accept: "text", deadline });
  const rules = robots.ok && robots.page.status === 200 ? readRobots(robots.page.html) : { sitemaps: [], disallow: [] };
  let sitemap: { found: boolean; url: string | null } | null = null;
  if (rules.sitemaps.length) sitemap = { found: true, url: rules.sitemaps[0] };
  else {
    const sm = await readPage(new URL("/sitemap.xml", home.page.finalUrl).toString(), deps, { accept: "text", deadline });
    sitemap = sm.ok ? { found: sm.page.status === 200 && /<(?:urlset|sitemapindex)\b/i.test(sm.page.html.slice(0, 5_000)), url: sm.page.status === 200 ? sm.page.finalUrl : null } : robots.ok ? { found: false, url: null } : null;
  }

  // The pages worth reading, as the home page links to them, four at a time.
  const finalHome = new URL(home.page.finalUrl);
  const sameSite = (u: URL) => onSameSite({ ...target, host: finalHome.hostname.toLowerCase() }, u);
  const wanted = pagesToRead(home.page, sameSite, MAX_EXTRA_PAGES);
  const allowed = wanted.filter((u) => {
    const ok = robotsAllow(new URL(u).pathname, rules.disallow);
    if (!ok) notes.push(`${u} was not read: the site's robots.txt asks robots not to.`);
    return ok;
  });
  const extra: Read[] = [];
  for (let i = 0; i < allowed.length; i += 4) {
    const batch = await Promise.all(allowed.slice(i, i + 4).map((u) => readPage(u, deps, { accept: "html", deadline })));
    batch.forEach((r, j) => {
      record(allowed[i + j], r);
      extra.push(r);
      if (!r.ok) notes.push(describeReadError(allowed[i + j], r.error));
    });
  }
  const snapshots = [home.page, ...extra.flatMap((r) => (r.ok ? [r.page] : []))];
  return { start: target.start, pages, checks: runSiteChecks({ pages: snapshots, https: { served, httpRedirects }, sitemap }), notes };
}
