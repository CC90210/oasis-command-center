/**
 * lib/web-leads/url-safety.ts — turns a raw, untrusted `websiteUrl` into
 * something safe to put in an `<a href>`, or null.
 *
 * Two independent problems, both found in the live 27,000-row data by an
 * independent review of the Task 4 panel (2026-08-21):
 *
 * 1. BARE DOMAINS NAVIGATE INSIDE OUR OWN APP. 217 of the stored website
 *    values have no scheme (e.g. "whitfield.co"). A bare string in an
 *    `href` is treated as app-RELATIVE, so clicking "View website" would
 *    navigate inside our own dashboard instead of out to the prospect's
 *    site -- exactly when a rep is mid-call and about to use it.
 * 2. NO SCHEME ALLOWLIST. These values come from OpenStreetMap, which
 *    anyone on the internet can edit, and we ingest ~27,000 of them
 *    automatically with no human review. Zero dangerous URLs exist in the
 *    data today, but that is a fact about today's snapshot, not a control:
 *    a `javascript:` value in that field would execute in our app's
 *    origin the instant a rep clicked the link. Allowlisting http/https
 *    (rather than denylisting javascript:/data:/etc.) is what keeps this
 *    closed against schemes nobody has thought of yet.
 *
 * Used anywhere this panel turns a lead's `websiteUrl` into a clickable
 * link. Callers must render nothing (not a disabled/dead link) when this
 * returns null -- a missing button is honest, a broken or dangerous one
 * is not.
 */

/**
 * Hosts where the PATH is the identity and the origin is useless.
 *
 * `facebook.com/joesplumbing` is Joe's website; `facebook.com` is not. Same for
 * every platform that hands businesses a page rather than a domain. Everywhere
 * else, the path is a page ON the business's own site and the origin is their
 * homepage.
 */
const PLATFORM_HOSTS = [
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com",
  "yelp.ca", "yelp.com", "tripadvisor.ca", "tripadvisor.com", "google.com", "goo.gl",
  "sites.google.com", "business.site", "wixsite.com", "squarespace.com", "wordpress.com",
  "blogspot.com", "shopify.com", "myshopify.com", "weebly.com", "godaddysites.com",
  "linktr.ee", "square.site", "ca.linkedin.com",
];

function isPlatformHost(host: string): boolean {
  const h = host.replace(/^www\./i, "").toLowerCase();
  return PLATFORM_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

/**
 * The URL a rep should actually be sent to — usually the business's HOMEPAGE,
 * not the deep path OpenStreetMap happens to store.
 *
 * WHY, WITH EVIDENCE (measured 2026-08-24): Adon reported "View website" giving
 * 404s across multiple leads. The links were well-formed and safeExternalUrl
 * was doing its job; the stored URLs themselves are simply stale. OSM entries
 * are contributed once and rarely revisited, so a path recorded years ago rots
 * while the domain stays fine. In a four-URL sample,
 * `mangomedical.ca/familypractice/` returned 410 Gone while `mangomedical.ca`
 * returned 200 — one in four dead, which matches "I tested it out with multiple
 * websites".
 *
 * A rep on a call wants to see the business's site, not one archived sub-page
 * of it. The origin is both what they want and the far more durable URL.
 *
 * The exception is platform hosts, where the path IS the business (see above) —
 * stripping it would send a rep to facebook.com's front page and tell them
 * nothing.
 *
 * Returns null on anything safeExternalUrl rejects, so every caller keeps the
 * same contract: render nothing rather than a dead or dangerous control.
 */
export function preferredSiteUrl(raw: string | null): string | null {
  const safe = safeExternalUrl(raw);
  if (!safe) return null;
  try {
    const u = new URL(safe);
    if (isPlatformHost(u.hostname)) return safe;
    // No meaningful path: already the homepage.
    if (u.pathname === "/" || u.pathname === "") return u.origin + "/";
    return u.origin + "/";
  } catch {
    return safe;
  }
}

export function safeExternalUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare domain in an href is app-RELATIVE, so it navigates inside our own
  // dashboard instead of out to the prospect. 217 of our stored websites are
  // bare domains.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    // Allowlist, not denylist. These URLs come from a public map that anyone
    // can edit, and a javascript: href would run in our origin the instant a
    // rep clicks it -- stored XSS delivered through a link.
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
