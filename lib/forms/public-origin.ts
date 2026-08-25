const FUNDING_TENANT_SLUGS = new Set(["sun", "submissions"]);

function normalizedHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
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
  if (FUNDING_TENANT_SLUGS.has(tenantSlug)) {
    const fundingOrigin = normalizedHttpsOrigin(process.env.SUNBIZ_PUBLIC_FORM_ORIGIN);
    if (fundingOrigin) return fundingOrigin;
  }

  return (
    normalizedHttpsOrigin(input.requestOrigin) ||
    normalizedHttpsOrigin(process.env.PUBLIC_APP_URL) ||
    normalizedHttpsOrigin(process.env.OASIS_PUBLIC_ORIGIN) ||
    normalizedHttpsOrigin(process.env.NEXT_PUBLIC_SITE_URL) ||
    "https://oasisai.work"
  );
}

