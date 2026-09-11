const FUNDING_TENANT_SLUGS = new Set(["sun", "submissions"]);

/**
 * SunBiz's own host, used for SunBiz links when SUNBIZ_PUBLIC_FORM_ORIGIN is
 * unset or unusable.
 *
 * It does not serve the form itself. SunBiz's site forwards /f/* to it with a
 * 307 that keeps the path and query (CC90210/sunbiz-funding, next.config.ts).
 * Measured 2026-09-11: a link on this host opens the merchant's own form, and
 * the address in their email is SunBiz's instead of OASIS's.
 * apply.sunbizfunding.com is not used here because it has no DNS record, so a
 * link on it would be dead.
 */
export const SUNBIZ_FALLBACK_FORM_ORIGIN = "https://www.sunbizfunding.com";

function normalizedPublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** OASIS's own domain. A SunBiz link is never built on it. */
function isOasisDomain(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "oasisai.work" || host.endsWith(".oasisai.work");
}

const warnedSunbizFallbacks = new Set<string>();

/**
 * The origin SunBiz links are built on.
 *
 * SUNBIZ_PUBLIC_FORM_ORIGIN when it is a usable https origin off OASIS's
 * domain. Otherwise the request or platform origin, as before, so a local
 * server or a preview deployment still links to itself, but never OASIS's
 * domain: that was the defect, SunBiz merchants receiving links on
 * oasisai.work. OASIS_PUBLIC_ORIGIN is OASIS's form setting, so SunBiz does
 * not read it. With nothing usable left, SunBiz's own host. Every fallback is
 * logged once per process, so a missing setting shows up in the logs.
 */
function sunbizPublicFormOrigin(requestOrigin?: string): string {
  const raw = process.env.SUNBIZ_PUBLIC_FORM_ORIGIN;
  const configured = normalizedPublicOrigin(raw);
  if (configured && !isOasisDomain(configured)) return configured;

  let origin = SUNBIZ_FALLBACK_FORM_ORIGIN;
  for (const candidate of [requestOrigin, process.env.NEXT_PUBLIC_SITE_URL, process.env.PUBLIC_APP_URL]) {
    const normalized = normalizedPublicOrigin(candidate);
    if (normalized && !isOasisDomain(normalized)) {
      origin = normalized;
      break;
    }
  }

  const state = !raw ? "not set" : configured ? "on OASIS's domain" : "not a bare https origin";
  const key = `${state}|${origin}`;
  if (!warnedSunbizFallbacks.has(key)) {
    warnedSunbizFallbacks.add(key);
    console.error(
      `[forms.public_origin] SUNBIZ_PUBLIC_FORM_ORIGIN is ${state}, so SunBiz merchant links use ${origin}. ` +
        "Set it to SunBiz's own https origin, e.g. https://apply.sunbizfunding.com once that host has a DNS record.",
    );
  }
  return origin;
}

/**
 * Pick the hostname used in links sent to public-form users.
 *
 * Funding links intentionally have their own origin. A merchant must not lose
 * access merely because a WiFi DNS/security policy blocks the platform's
 * shared .work hostname. Other tenants keep the request/platform origin.
 */
export function publicFormOrigin(input: {
  tenantSlug: string;
  requestOrigin?: string;
}): string {
  const tenantSlug = input.tenantSlug.trim().toLowerCase();
  if (FUNDING_TENANT_SLUGS.has(tenantSlug)) return sunbizPublicFormOrigin(input.requestOrigin);

  return (
    normalizedPublicOrigin(input.requestOrigin) ||
    normalizedPublicOrigin(process.env.OASIS_PUBLIC_ORIGIN) ||
    normalizedPublicOrigin(process.env.NEXT_PUBLIC_SITE_URL) ||
    normalizedPublicOrigin(process.env.PUBLIC_APP_URL) ||
    "https://oasisai.work"
  );
}

/**
 * A stored SunBiz form link, rebuilt on SunBiz's public origin for sending.
 *
 * A link is stored on the lead when it is minted, so it keeps the host it was
 * minted on. On 2026-09-11, 736 SunBiz leads still held one on oasisai.work
 * from before SUNBIZ_PUBLIC_FORM_ORIGIN was set, and 359 of 456 SunBiz
 * sequence emails since then went out with one. Rebuilding the origin at send
 * time fixes those without rewriting stored data, and follows the setting when
 * it changes again. Only this app's SunBiz form paths change: OASIS links,
 * other sites and anything unparseable come back as they were.
 */
export function sunbizFormLinkForSend(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const [, root, slug] = parsed.pathname.split("/");
  if (root !== "f" || !FUNDING_TENANT_SLUGS.has((slug || "").toLowerCase())) return url;
  const origin = sunbizPublicFormOrigin();
  if (parsed.origin === origin) return url;
  return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
