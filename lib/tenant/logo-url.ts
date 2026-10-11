/**
 * lib/tenant/logo-url.ts - the URL a workspace's uploaded logo is drawn from.
 *
 * PURE and client-safe: the Settings card (a client component) and the public
 * form and offer pages (server components) all call it.
 *
 * WHY THIS EXISTS (2026-10-11, Adon: "my logo doesn't show"). The logo upload
 * (app/api/tenant/logo) writes the object to the ONE R2 bucket under
 * `tenant-assets/<tenant>/<file>` and stored, on tenants.logo_url, whatever
 * `getPublicUrl` returned: R2_PUBLIC_BASE_URL plus that key. OASIS's row holds
 * `https://pub-<id>.r2.dev/tenant-assets/<tenant>/<file>`, and that address
 * answers 404: the public r2.dev host does not serve the object the S3 API
 * wrote. (Without R2_PUBLIC_BASE_URL the same call returns an hour-long SIGNED
 * URL, which would have broken the same way an hour later.) The bucket is the
 * merchant-document bucket, so making it public is not the fix.
 *
 * The fix is a first-party address that never expires and never needs the
 * bucket to be public: /api/tenant-assets/<tenant>/<file>, which streams the
 * object from R2 server-side and serves only images in the public
 * `tenant-assets` prefix (lib/tenant/tenant-asset-response.ts). Every stored
 * shape of a tenant-assets URL (the r2.dev one, a signed R2 one, a Supabase
 * public one, the new route itself) is read back to that route here, so rows
 * written before the fix render too, with no data change.
 *
 * Anything else stays as it was: an absolute https URL an operator typed into
 * a form's branding, or a first-party path such as /brand/oasis-mark.png. A
 * value that is neither (javascript:, data:, a protocol-relative //host) is not
 * drawn at all: no logo is better than an address we did not mean to load.
 */

/** The public route that serves objects in the tenant-assets prefix. */
export const TENANT_ASSET_ROUTE = "/api/tenant-assets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One path segment as the uploaders write it (sanitizeStorageFilename's charset). */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
/** Logos sit at <tenant>/<file>; offer-page thumbnails at <tenant>/offer-pages/<file>. */
const MAX_SEGMENTS_AFTER_TENANT = 2;

/**
 * The object path inside the tenant-assets prefix (`<tenant uuid>/<file>`), or
 * null when the segments are not exactly that shape. Shared by the URL reader
 * below and by the route, so the two can never disagree about what is servable.
 */
export function tenantAssetPathFromSegments(segments: readonly string[]): string | null {
  if (segments.length < 2 || segments.length > 1 + MAX_SEGMENTS_AFTER_TENANT) return null;
  const [tenant, ...rest] = segments;
  if (!UUID.test(tenant)) return null;
  for (const s of rest) {
    if (!SEGMENT.test(s) || s.includes("..")) return null;
  }
  // Never re-cased: an object key is case-sensitive.
  return [tenant, ...rest].join("/");
}

/**
 * The tenant-assets object a stored URL points at, or null when it points at
 * anything else. Reads the URL's path only (any host): the part after a
 * `tenant-assets` segment must be `<tenant uuid>/<file>`.
 */
export function tenantAssetPathFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, "https://first-party.invalid");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const at = segments.lastIndexOf("tenant-assets");
  if (at < 0) return null;
  return tenantAssetPathFromSegments(segments.slice(at + 1));
}

/** The first-party URL for an object path in the tenant-assets prefix. */
export function tenantAssetUrl(path: string): string {
  return `${TENANT_ASSET_ROUTE}/${path}`;
}

/**
 * The URL to draw a logo from, or null to draw none.
 *
 *   tenant-assets object, any stored shape  -> /api/tenant-assets/<tenant>/<file>
 *   absolute http(s) URL                     -> unchanged
 *   first-party path ("/...")                -> unchanged
 *   anything else, or empty                  -> null
 */
export function displayLogoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const asset = tenantAssetPathFromUrl(s);
  if (asset) return tenantAssetUrl(asset);
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return s;
  return null;
}
