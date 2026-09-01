/**
 * recheck-url.ts — validation for an operator-supplied re-check URL.
 *
 * The value a rep pastes into the battle card ends up fetched BY OUR CRAWLER
 * from inside our network, which makes this an SSRF door if it accepts
 * loopback, private-range, link-local or cloud-metadata targets (Codex
 * review, 2026-09-01: `http://127.0.0.1:3000`, `http://169.254.169.254/...`).
 * So the rule is allowlist-shaped twice over: scheme must be http/https, and
 * the hostname must not be any literal or name that points inward. The
 * JARVIS worker re-checks the same rules AND resolves the hostname before
 * fetching (defence at the point of use); redirect-chain re-validation inside
 * the fetcher is tracked as staged hardening with the model-v2 batch.
 */

const PRIVATE_HOSTNAMES = new Set(["localhost", "0.0.0.0", "broadcasthost"]);
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp"];

/** Literal IPv4 in a range that must never be crawled from our network. */
export function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return true; // malformed = refuse
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * http/https, parseable, public-looking hostname, nothing else. Returns the
 * normalized href or null. IPv6 literals are refused wholesale: no legitimate
 * small-business website is supplied as a bracketed IPv6 address, and the
 * private-range arithmetic there is where allowlists go to die.
 */
export function validatedRecheckUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return null;
    if (host.startsWith("[")) return null; // IPv6 literal
    if (PRIVATE_HOSTNAMES.has(host)) return null;
    if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return null;
    if (isPrivateIpv4(host)) return null;
    if (u.username || u.password) return null; // credentials in a URL are never a website
    return u.href;
  } catch {
    return null;
  }
}

const recheckUrlModule = { validatedRecheckUrl, isPrivateIpv4 };
export default recheckUrlModule;
