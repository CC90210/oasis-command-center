/**
 * lib/email/tracking-base.ts — resolve the origin that tracked email URLs are
 * built on, and the host the click route will trust for that origin.
 *
 * Pure and free of "server-only" so both sides of the contract can import the
 * SAME logic and be unit-tested: lib/email/tracked-html.ts mints the links, and
 * app/api/track/click/[id] decides which hosts it will redirect to without a
 * signature. Those two drifting apart would silently downgrade every click on
 * the new domain to the safe default, which looks like a broken campaign rather
 * than a config error.
 *
 * WHY A SEPARATE DOMAIN AT ALL: drip mail is sent From
 * submissions@sunbizfunding.com while every URL inside it was built on
 * oasisai.work. A visible sender whose links all point somewhere unrelated is a
 * strong spam signal (it is the shape phishing takes), and it means the sending
 * domain earns no reputation from engagement while carrying all the complaint
 * risk.
 */

/**
 * Validate a configured tracking origin, falling back when it is unusable.
 *
 * Deliberately fail-SAFE rather than fail-closed: a bad value here would break
 * every link in every email, so we fall back to the known-good platform origin
 * and keep sending. The cost of the fallback is a spam signal; the cost of the
 * alternative is mail nobody can click. Returns a bare `https://host` with no
 * path and no trailing slash.
 */
export function resolveTrackingBase(configured: string | undefined, fallback: string): string {
  const cleanFallback = fallback.replace(/\/+$/, "");
  const raw = (configured || "").trim();
  if (!raw) return cleanFallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return cleanFallback;
    return `${u.protocol}//${u.host}`;
  } catch {
    return cleanFallback;
  }
}

/**
 * The hostname of a configured tracking origin, or null when it is absent or
 * unusable. A malformed value contributes NOTHING to the click allowlist rather
 * than widening it, which is the one place here that must fail closed: the
 * allowlist decides where an unsigned link may redirect a merchant.
 */
export function trackingHost(configured: string | undefined): string | null {
  const raw = (configured || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
