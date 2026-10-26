/**
 * lib/ai-audit/site-url.ts — which address the pre-call checks may fetch.
 *
 * The lead's "Website or social handle" answer is free text: "acme.ca",
 * "https://www.acme.ca/services", "@acme", "instagram.com/acme". Only the
 * business's own public website is fetched. A social profile is recorded as
 * one and never fetched: those platforms need a login, and their pages are not
 * the business's own site (the brief lists them as a gap to look at by hand).
 *
 * Refused outright: IP addresses (v4 in any spelling the URL parser accepts,
 * and v6), single-label and internal names, reserved test domains, names under
 * services that answer with the address written in the name or with a private
 * one (127.0.0.1.nip.io, localtest.me), ports, and user names or passwords in
 * the address. A business website is a domain name on the default port. The
 * name check is by spelling only, so these lists are defence in depth, not a
 * DNS check. Every redirect hop is checked again
 * (lib/ai-audit/site-fetch.ts), so a public site cannot bounce the fetch into
 * a private address. Stricter than the chat tool's lib/cloud-tool-runner.ts
 * assertSafeUrl, which lets some loopback and IPv6 forms through.
 *
 * PURE.
 */

export type SiteTarget =
  | { kind: "site"; start: string; origin: string; host: string; pathPrefix: string }
  | { kind: "social"; platform: string; url: string | null }
  | { kind: "none"; reason: "empty" | "not_a_url" | "not_public" };

/** Platforms whose pages are not a business's own website. */
const SOCIAL: ReadonlyArray<readonly [string, RegExp]> = [
  ["Instagram", /(^|\.)instagram\.com$/],
  ["Facebook", /(^|\.)(facebook\.com|fb\.com|fb\.me)$/],
  ["TikTok", /(^|\.)tiktok\.com$/],
  ["LinkedIn", /(^|\.)linkedin\.com$/],
  ["X (Twitter)", /(^|\.)(x\.com|twitter\.com)$/],
  ["YouTube", /(^|\.)(youtube\.com|youtu\.be)$/],
  ["Linktree", /(^|\.)linktr\.ee$/],
  ["Pinterest", /(^|\.)pinterest\.(com|ca)$/],
  ["Yelp", /(^|\.)yelp\.(com|ca)$/],
  ["Etsy", /(^|\.)etsy\.com$/],
  ["Google Business Profile", /(^|\.)(g\.page|maps\.app\.goo\.gl|goo\.gl)$/],
  ["Threads", /(^|\.)threads\.(net|com)$/],
];

/** Site builders that host many businesses under one name, each in its own folder ("acme.wixsite.com/acme"). */
const PATH_SITES: readonly RegExp[] = [/\.wixsite\.com$/, /(^|\.)square\.site$/, /(^|\.)sites\.google\.com$/];

/** Names that are never a business's public website. */
const BLOCKED_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "home.arpa", "localdomain", "test", "example", "invalid", "onion", "arpa", "svc"];
/** Services whose every name points at the address written in it (127.0.0.1.nip.io) or at the machine itself (localtest.me). */
const PRIVATE_DNS = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "vcap.me", "traefik.me"];

/** A public DNS name: two or more labels, a letter top-level label, no IP address in any form. */
export function isPublicHostname(raw: string): boolean {
  const h = raw.toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return false;
  // IPv6 ("[::1]" as the URL parser keeps it) and IPv4. The parser has already
  // turned "0x7f.1", "2130706433" and "127.1" into dotted quads.
  if (h.includes(":") || h.startsWith("[")) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld)) return false;
  return ![...BLOCKED_SUFFIXES, ...PRIVATE_DNS].some((s) => h === s || h.endsWith(`.${s}`));
}

/** May this address be fetched (an http(s) URL on a public name, default port, no credentials)? */
export function isFetchableUrl(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password || u.port) return false;
  return isPublicHostname(u.hostname);
}

function socialPlatform(host: string, path: string): string | null {
  for (const [platform, re] of SOCIAL) if (re.test(host)) return platform;
  if (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/maps\b/.test(path)) return "Google Maps";
  return null;
}

/** What the lead's website answer points at. */
export function siteTarget(raw: string | null | undefined): SiteTarget {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "none", reason: "empty" };
  // "@acme": a handle, on a platform the answer does not name.
  if (/^@[\w.]{1,60}$/.test(s)) return { kind: "social", platform: "a social network", url: null };
  if (/\s/.test(s)) return { kind: "none", reason: "not_a_url" };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { kind: "none", reason: "not_a_url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { kind: "none", reason: "not_a_url" };
  const host = u.hostname.toLowerCase();
  const platform = socialPlatform(host, u.pathname);
  if (platform) return { kind: "social", platform, url: `${u.protocol}//${u.host}${u.pathname}` };
  if (!isFetchableUrl(u)) return { kind: "none", reason: "not_public" };
  // Always HTTPS first, whatever the lead typed: the read falls back to plain
  // HTTP only when the secure address does not answer, and then says so.
  const origin = `https://${host}`;
  // On a shared builder the business lives in its folder; elsewhere the checks start at the home page.
  if (PATH_SITES.some((re) => re.test(host))) {
    const folder = u.pathname.split("/").filter(Boolean)[0];
    const prefix = folder ? `/${folder}` : "/";
    return { kind: "site", start: `${origin}${prefix === "/" ? "/" : `${prefix}/`}`, origin, host, pathPrefix: prefix };
  }
  return { kind: "site", start: `${origin}/`, origin, host, pathPrefix: "/" };
}

/** Is `url` part of the same site as `target` (same host, inside its folder)? */
export function onSameSite(target: Extract<SiteTarget, { kind: "site" }>, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const bare = (h: string) => h.replace(/^www\./, "");
  if (bare(host) !== bare(target.host)) return false;
  return target.pathPrefix === "/" || url.pathname === target.pathPrefix || url.pathname.startsWith(`${target.pathPrefix}/`);
}
