/**
 * lib/ai-audit/site-fetch.ts — read a business's own website for the
 * pre-call brief: the home page, up to eight of its pages that matter to a
 * service business (contact, booking, services, pricing, about), robots.txt
 * and the sitemap. Then run the checks (site-checks.ts) over what was read.
 *
 * How it fetches, every time:
 *   - only addresses lib/ai-audit/site-url.ts allows (public names, default
 *     ports, no credentials), checked again on every redirect hop, at most 5;
 *   - HTTPS first, whatever the lead typed; plain HTTP only when the secure
 *     address does not answer at all, and the brief then says so;
 *   - an honest user agent that says who is reading and why;
 *   - robots.txt first, once for each scheme and host, and its rules followed
 *     for every request after it, the home page and the sitemap included, on
 *     every redirect hop. As RFC 9309 reads it: the group for our agent, else
 *     the group for everyone; a robots.txt that answers 4xx means no rules;
 *     one that cannot be read (a 5xx, no answer) means nothing there is read;
 *   - each response read up to MAX_PAGE_BYTES, each request stopped after
 *     PAGE_TIMEOUT_MS, the whole read stopped after TOTAL_BUDGET_MS;
 *   - nothing is sent but a plain GET, never a cookie or a login.
 *
 * Every request is kept as a record (the brief stores each one as a source).
 * What failed or was not read goes in `notes`, never into the checks as a
 * "no": a read that failed is a gap, not an absence. When the home page was
 * not read, there are no checks at all.
 *
 * The fetch itself is passed in, so tests run on fixtures without a network.
 */
import { isFetchableUrl, onSameSite, type SiteTarget } from "@/lib/ai-audit/site-url";
import {
  MAX_URL_CHARS,
  ROBOTS_AGENT,
  asciiLower,
  pagesToRead,
  readRobots,
  robotsAllow,
  runSiteChecks,
  type PageSnapshot,
  type RobotsRules,
  type SiteCheck,
  type SitemapFinding,
} from "@/lib/ai-audit/site-checks";

export const MAX_PAGE_BYTES = 600_000;
export const PAGE_TIMEOUT_MS = 8_000;
export const TOTAL_BUDGET_MS = 25_000;
export const MAX_REDIRECTS = 5;
export const MAX_EXTRA_PAGES = 8;
export const USER_AGENT = `${ROBOTS_AGENT}/1.0 (+https://oasisai.work; reads public pages for an AI audit the business asked for)`;

export type FetchLike = (url: string, init: { method: "GET"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export type SiteReadDeps = { fetch: FetchLike; clock: () => number };

/** One request as made: what the brief stores (a hash and an excerpt), never the page itself. */
export type PageRecord = {
  /** A page of the site, its robots.txt, a sitemap, or the plain-HTTP address (does it send visitors to HTTPS?). */
  kind: "site_page" | "robots_txt" | "sitemap" | "http_check";
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
  /** Every request, in the order made: the brief's sources. */
  pages: PageRecord[];
  checks: SiteCheck[];
  /** What failed or was not read, in words for the brief's gaps. */
  notes: string[];
  /** Why nothing on the site was read (and there are no checks), or null when its home page was. */
  unread: "no_answer" | "not_allowed" | "home_page_failed" | null;
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

/**
 * GET one address, following redirects one hop at a time, each hop checked: a
 * public address and, when `mayRead` is given, one its site's robots.txt
 * allows (`mayRead` answers why not, as an error code, when it does not).
 */
export async function readPage(
  url: string,
  deps: SiteReadDeps,
  opts: { accept: "html" | "text"; deadline: number; mayRead?: (u: URL) => Promise<string | null> },
): Promise<Read> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return { ok: false, error: "bad_address", finalUrl: current, status: null };
    }
    if (!isFetchableUrl(u)) return { ok: false, error: hop ? "redirected_off_the_public_web" : "not_public", finalUrl: u.toString(), status: null };
    // Out of time first: otherwise a robots.txt that ran out of time would be blamed for the page.
    if (opts.deadline - deps.clock() <= 0) return { ok: false, error: "out_of_time", finalUrl: u.toString(), status: null };
    const closed = opts.mayRead ? await opts.mayRead(u) : null;
    if (closed) return { ok: false, error: closed, finalUrl: u.toString(), status: null };
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
  const lower = asciiLower(html);
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
  robots_closed: "was not read: the site's robots.txt asks robots not to",
  robots_unreadable: "was not read: the site's robots.txt could not be read, and the robots.txt standard (RFC 9309) then says to read nothing there",
};

export function describeReadError(url: string, error: string): string {
  return `${url} ${ERROR_WORDS[error] ?? `could not be read (${error})`}.`;
}

/** A site's robots.txt as RFC 9309 reads it: a 2xx answer gives its rules, a 4xx means there are none, anything else (a 5xx, no answer) closes the site. */
type Robots = { url: string; read: Read; open: boolean; rules: RobotsRules; sitemaps: string[] };

function robotsFrom(url: string, read: Read): Robots {
  const closed: Robots = { url, read, open: false, rules: { allow: [], disallow: [] }, sitemaps: [] };
  if (!read.ok) return closed;
  const status = read.page.status;
  if (status >= 400 && status < 500) return { ...closed, open: true };
  if (status < 200 || status >= 300) return closed;
  const parsed = readRobots(read.page.html);
  // A sitemap named by a relative address is read against robots.txt's own.
  const sitemaps = parsed.sitemaps.flatMap((s) => {
    try {
      const resolved = new URL(s, read.page.finalUrl).toString();
      return resolved.length <= MAX_URL_CHARS ? [resolved] : [];
    } catch {
      return [];
    }
  });
  return { ...closed, open: true, rules: { allow: parsed.allow, disallow: parsed.disallow }, sitemaps };
}

/** The errors that mean the site did not answer at all. */
const NO_ANSWER = /^(unreachable|timed_out)/;

/** Read the site and run the checks. Never throws for a bad site: what failed goes in `notes`. */
export async function readSite(target: Extract<SiteTarget, { kind: "site" }>, deps: SiteReadDeps): Promise<SiteReport> {
  const deadline = deps.clock() + TOTAL_BUDGET_MS;
  const pages: PageRecord[] = [];
  const notes: string[] = [];
  const record = (kind: PageRecord["kind"], url: string, r: Read) => {
    pages.push(
      r.ok
        ? { kind, url, finalUrl: r.page.finalUrl, status: r.page.status, bytes: r.page.bytes, ms: r.page.ms, title: kind === "site_page" || kind === "http_check" ? titleOf(r.page.html) : null, error: null, html: r.page.html }
        : { kind, url, finalUrl: r.finalUrl, status: r.status, bytes: 0, ms: 0, title: null, error: r.error, html: null },
    );
  };
  const done = (checks: SiteCheck[], unread: SiteReport["unread"]): SiteReport => ({ start: target.start, pages, checks, notes, unread });

  // robots.txt, once for each scheme and host, before anything else there is read.
  const robotsByOrigin = new Map<string, Promise<Robots>>();
  const robotsOf = (origin: string): Promise<Robots> => {
    let robots = robotsByOrigin.get(origin);
    if (!robots) {
      const url = `${origin}/robots.txt`;
      robots = readPage(url, deps, { accept: "text", deadline }).then((r) => {
        record("robots_txt", url, r);
        return robotsFrom(url, r);
      });
      robotsByOrigin.set(origin, robots);
    }
    return robots;
  };
  const mayRead = async (u: URL): Promise<string | null> => {
    const robots = await robotsOf(u.origin);
    if (!robots.open) return "robots_unreadable";
    return robotsAllow(`${u.pathname}${u.search}`, robots.rules) ? null : "robots_closed";
  };

  // The first request is robots.txt over HTTPS. A site that does not answer on
  // the secure address at all is read over plain HTTP, and that is a finding.
  let start = target.start;
  let robots = await robotsOf(new URL(start).origin);
  let secureFailure: { url: string; excerpt: string } | null = null;
  if (!robots.read.ok && /^unreachable/.test(robots.read.error)) {
    secureFailure = { url: robots.url, excerpt: describeReadError(robots.url, robots.read.error) };
    notes.push(secureFailure.excerpt);
    const plain = new URL(start);
    plain.protocol = "http:";
    start = plain.toString();
    robots = await robotsOf(plain.origin);
  }
  if (!robots.open) {
    const r = robots.read;
    if (!r.ok && NO_ANSWER.test(r.error)) {
      notes.push(describeReadError(robots.url, r.error));
      return done([], "no_answer");
    }
    const why = r.ok ? `${robots.url} answered with HTTP ${r.page.status}` : describeReadError(robots.url, r.error).replace(/\.$/, "");
    notes.push(`${why}, so, as the robots.txt standard (RFC 9309) asks, nothing on the site was read.`);
    return done([], "not_allowed");
  }

  // The home page, under robots.txt like every request after it.
  const home = await readPage(start, deps, { accept: "html", deadline, mayRead });
  record("site_page", start, home);
  if (!home.ok) {
    notes.push(describeReadError(start, home.error));
    return done([], NO_ANSWER.test(home.error) ? "no_answer" : /^robots_/.test(home.error) ? "not_allowed" : "home_page_failed");
  }
  if (home.page.status < 200 || home.page.status >= 300) {
    notes.push(`${start} answered with HTTP ${home.page.status}, so nothing on the site was read.`);
    return done([], "home_page_failed");
  }
  const served = home.page.finalUrl.startsWith("https:");

  // Does plain http:// send visitors to the secure address? Not asked (or no
  // answer): nothing is said about it.
  let httpRedirects: boolean | null = null;
  if (served && start.startsWith("http:")) httpRedirects = true;
  else if (served) {
    const plain = new URL(start);
    plain.protocol = "http:";
    const r = await readPage(plain.toString(), deps, { accept: "html", deadline, mayRead });
    record("http_check", plain.toString(), r);
    httpRedirects = r.ok ? r.page.finalUrl.startsWith("https:") : null;
  }

  // The sitemap: the one robots.txt names, then /sitemap.xml. A read that
  // failed or was not allowed makes it unknown, never "no".
  const finalHome = new URL(home.page.finalUrl);
  const sameSite = (u: URL) => onSameSite({ ...target, host: finalHome.hostname.toLowerCase() }, u);
  const named = (await robotsOf(finalHome.origin)).sitemaps[0] ?? null;
  const tried: string[] = [];
  let sitemap: SitemapFinding | null = null;
  let unknown: string | null = null;
  for (const candidate of new Set([named, new URL("/sitemap.xml", finalHome).toString()])) {
    if (!candidate) continue;
    if (!sameSite(new URL(candidate))) {
      unknown ??= `robots.txt names a sitemap at ${candidate}, on another site, so it was not read.`;
      continue;
    }
    const r = await readPage(candidate, deps, { accept: "text", deadline, mayRead });
    record("sitemap", candidate, r);
    tried.push(candidate);
    if (r.ok && r.page.status === 200 && /<(?:urlset|sitemapindex)\b/i.test(r.page.html.slice(0, 5_000))) {
      sitemap = { found: true, url: r.page.finalUrl };
      break;
    }
    // Not there: a 404 or 410, or a 200 that is not a sitemap. A compressed file is not opened, so it is not known.
    const status = r.ok ? r.page.status : null;
    const compressed = r.ok && (/gzip/i.test(r.page.contentType) || /\.gz$/i.test(new URL(candidate).pathname));
    if (status === 404 || status === 410 || (status === 200 && !compressed)) continue;
    unknown ??= !r.ok
      ? `${describeReadError(candidate, r.error).replace(/\.$/, "")}, so whether the site has a sitemap there is not known.`
      : compressed
        ? `${candidate} is a compressed file, which was not opened, so whether it is a sitemap is not known.`
        : `${candidate} answered with HTTP ${status}, so whether the site has a sitemap there is not known.`;
  }
  sitemap ??= unknown
    ? { unknown }
    : { found: false, url: tried[tried.length - 1] ?? null, detail: named ? `robots.txt names a sitemap at ${named}, but it is not there${tried.length > 1 ? ", and there is none at /sitemap.xml" : ""}.` : undefined };

  // The pages worth reading, as the home page links to them, four at a time.
  const wanted = pagesToRead(home.page, sameSite, MAX_EXTRA_PAGES);
  const extra: Read[] = [];
  for (let i = 0; i < wanted.length; i += 4) {
    const batch = await Promise.all(wanted.slice(i, i + 4).map((u) => readPage(u, deps, { accept: "html", deadline, mayRead })));
    batch.forEach((r, j) => {
      const u = wanted[i + j];
      record("site_page", u, r);
      extra.push(r);
      if (!r.ok) notes.push(describeReadError(u, r.error));
      else if (r.page.status < 200 || r.page.status >= 300) notes.push(`${u} answered with HTTP ${r.page.status}, so it was not checked.`);
    });
  }
  const snapshots = [home.page, ...extra.flatMap((r) => (r.ok ? [r.page] : []))];
  return done(runSiteChecks({ pages: snapshots, https: { served, httpRedirects, secureFailure }, sitemap }), null);
}
