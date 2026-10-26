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
 *     address does not answer at all, asked twice (one failed request is not
 *     enough to say a site has no HTTPS), and the brief then says so;
 *   - an honest user agent that says who is reading and why;
 *   - robots.txt first, once for each scheme and host, and its rules followed
 *     for every request after it, the home page and the sitemap included, on
 *     every redirect hop. As RFC 9309 reads it: the group for our agent, else
 *     the group for everyone; a robots.txt that answers 4xx means no rules;
 *     one that cannot be read (a 5xx, no answer), or that has more rules for
 *     us than are followed, means nothing there is read;
 *   - each response read up to MAX_PAGE_BYTES, each request stopped after
 *     PAGE_TIMEOUT_MS, the whole read stopped after TOTAL_BUDGET_MS;
 *   - nothing is sent but a plain GET, never a cookie or a login.
 *
 * Every request is kept as a record (the brief stores each one as a source).
 * What failed or was not read goes in `notes`, never into the checks as a
 * "no": a read that failed is a gap, not an absence, and a contact or booking
 * page that was not read makes what it would have shown unknown. When the
 * home page was not read, or is not the business's own (a domain parking
 * page, a host's placeholder, a page that sends visitors on), there are no
 * checks at all; another page that is not (a bot check) is not checked, and
 * counts as not read.
 *
 * The fetch itself is passed in, so tests run on fixtures without a network.
 */
import { isFetchableUrl, onSameSite, type SiteTarget } from "@/lib/ai-audit/site-url";
import {
  MAX_ROBOTS_RULES,
  MAX_URL_CHARS,
  ROBOTS_AGENT,
  asciiLower,
  notTheSite,
  pagesToRead,
  readRobots,
  robotsAllow,
  runSiteChecks,
  type LinkedPage,
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
  /** The address the read started from: the target's HTTPS one, or its plain-HTTP twin when the secure address did not answer. */
  start: string;
  /** Every request, in the order made: the brief's sources. */
  pages: PageRecord[];
  checks: SiteCheck[];
  /** What failed or was not read, in words for the brief's gaps. */
  notes: string[];
  /** Why nothing on the site was read or checked (and there are no checks), or null when its home page was. */
  unread: "no_answer" | "not_allowed" | "home_page_failed" | "not_the_site" | null;
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
    // The request's own limit, or less when less of the whole read's time is left: then that is what stopped it.
    const limit = Math.min(PAGE_TIMEOUT_MS, left);
    const timer = setTimeout(() => controller.abort(), limit);
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
        try {
          current = new URL(location, u).toString();
        } catch {
          // The site answered, with a redirect to an address that is not one: not "unreachable".
          return { ok: false, error: "bad_redirect", finalUrl: u.toString(), status: res.status };
        }
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
      const stopped = limit < PAGE_TIMEOUT_MS ? "timed_out_budget" : "timed_out";
      return { ok: false, error: controller.signal.aborted ? stopped : `unreachable${err instanceof Error && /certificate|tls|ssl/i.test(err.message) ? "_tls" : ""}`, finalUrl: u.toString(), status: null };
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
  bad_redirect: "redirected to an address that is not a valid one, so it was not followed",
  out_of_time: "was not read: the time for reading the site ran out",
  timed_out: `did not answer within ${PAGE_TIMEOUT_MS / 1000} seconds`,
  timed_out_budget: "did not answer before the time for reading the site ran out",
  unreachable: "could not be reached",
  unreachable_tls: "could not be reached over a secure connection (a certificate problem)",
  not_a_web_page: "is not a web page",
  too_many_redirects: `redirected more than ${MAX_REDIRECTS} times`,
  bad_address: "is not a valid address",
  robots_closed: "was not read: the site's robots.txt asks robots not to",
  robots_unreadable: "was not read: the site's robots.txt could not be read, and the robots.txt standard (RFC 9309) then says to read nothing there",
  robots_too_many_rules: `was not read: the site's robots.txt has more rules for robots like ours than are followed (${MAX_ROBOTS_RULES.toLocaleString("en-US")}), and any of the rest might close it`,
};

export function describeReadError(url: string, error: string): string {
  return `${url} ${ERROR_WORDS[error] ?? `could not be read (${error})`}.`;
}

/** A site's robots.txt as RFC 9309 reads it: a 2xx answer gives its rules, a 4xx means there are none, anything else (a 5xx, no answer) closes the site. */
type Robots = { url: string; read: Read; open: boolean; rules: RobotsRules; sitemaps: string[] };

function robotsFrom(url: string, read: Read): Robots {
  const closed: Robots = { url, read, open: false, rules: { allow: [], disallow: [], tooMany: false }, sitemaps: [] };
  if (!read.ok) return closed;
  const status = read.page.status;
  if (status >= 400 && status < 500) return { ...closed, open: true };
  if (status < 200 || status >= 300) return closed;
  // The whole file, as read (at most MAX_PAGE_BYTES); cut off at the limit, its last line is read only if it closes.
  const parsed = readRobots(read.page.html, ROBOTS_AGENT, read.page.truncated);
  // A sitemap named by a relative address is read against robots.txt's own.
  const sitemaps = parsed.sitemaps.flatMap((s) => {
    try {
      const resolved = new URL(s, read.page.finalUrl).toString();
      return resolved.length <= MAX_URL_CHARS ? [resolved] : [];
    } catch {
      return [];
    }
  });
  return { ...closed, open: true, rules: { allow: parsed.allow, disallow: parsed.disallow, tooMany: parsed.tooMany }, sitemaps };
}

/** The errors that mean the site did not answer at all. */
const NO_ANSWER = /^(unreachable|timed_out)/;

/** Read the site and run the checks. Never throws for a bad site: what failed goes in `notes`. */
export async function readSite(target: Extract<SiteTarget, { kind: "site" }>, deps: SiteReadDeps): Promise<SiteReport> {
  const deadline = deps.clock() + TOTAL_BUDGET_MS;
  const pages: PageRecord[] = [];
  const notes: string[] = [];
  // Where the read starts: the target's HTTPS address, or its plain-HTTP twin once the secure one has not answered.
  let start = target.start;
  const record = (kind: PageRecord["kind"], url: string, r: Read) => {
    pages.push(
      r.ok
        ? { kind, url, finalUrl: r.page.finalUrl, status: r.page.status, bytes: r.page.bytes, ms: r.page.ms, title: kind === "site_page" || kind === "http_check" ? titleOf(r.page.html) : null, error: null, html: r.page.html }
        : { kind, url, finalUrl: r.finalUrl, status: r.status, bytes: 0, ms: 0, title: null, error: r.error, html: null },
    );
  };
  // The start actually used, so the brief never cites an address that was not asked for.
  const done = (checks: SiteCheck[], unread: SiteReport["unread"]): SiteReport => ({ start, pages, checks, notes, unread });

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
    if (robots.rules.tooMany) return "robots_too_many_rules";
    return robotsAllow(`${u.pathname}${u.search}`, robots.rules) ? null : "robots_closed";
  };

  // The first request is robots.txt over HTTPS. A site that does not answer on
  // the secure address at all is read over plain HTTP, and that is a finding:
  // so the secure address is asked twice first, since one failed request (a
  // dropped connection) is not enough to say a site has no HTTPS.
  const secureOrigin = new URL(start).origin;
  let robots = await robotsOf(secureOrigin);
  if (!robots.read.ok && /^unreachable/.test(robots.read.error)) {
    robotsByOrigin.delete(secureOrigin);
    robots = await robotsOf(secureOrigin);
  }
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
  // A page that is not the business's own (a domain parking page, a host's placeholder, a bot check) is not measured as its site.
  const other = notTheSite(home.page);
  if (other) {
    notes.push(`${start} showed what looks like ${other.what} ("${other.seen.replace(/\s+/g, " ")}"), not the business's own site, so nothing on it was checked.`);
    return done([], "not_the_site");
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
  // One that was not read is kept with its kind: what the contact or booking
  // page would have shown is then unknown, never "no".
  const wanted = pagesToRead(home.page, sameSite, MAX_EXTRA_PAGES);
  const extra: PageSnapshot[] = [];
  const unread: LinkedPage[] = [];
  for (let i = 0; i < wanted.length; i += 4) {
    const batch = await Promise.all(wanted.slice(i, i + 4).map((w) => readPage(w.url, deps, { accept: "html", deadline, mayRead })));
    batch.forEach((r, j) => {
      const w = wanted[i + j];
      record("site_page", w.url, r);
      // Like the home page, a page that is not the business's own (a bot check, a page that sends visitors on) is not measured as part of the site.
      const other = r.ok && r.page.status >= 200 && r.page.status < 300 ? notTheSite(r.page) : null;
      if (!r.ok) {
        notes.push(describeReadError(w.url, r.error));
        unread.push(w);
      } else if (r.page.status < 200 || r.page.status >= 300) {
        notes.push(`${w.url} answered with HTTP ${r.page.status}, so it was not checked.`);
        unread.push(w);
      } else if (other) {
        notes.push(`${w.url} showed what looks like ${other.what} ("${other.seen.replace(/\s+/g, " ")}"), so it was not checked.`);
        unread.push(w);
      } else extra.push(r.page);
    });
  }
  const snapshots = [home.page, ...extra];
  return done(runSiteChecks({ pages: snapshots, https: { served, httpRedirects, secureFailure }, sitemap, unread }), null);
}
