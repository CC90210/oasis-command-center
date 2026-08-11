const LEAD_DOCUMENT_BUCKET = "lead-documents";

/**
 * Convert the legacy absolute R2 URLs written by the storage migration back to
 * the tenant-relative object key used by every storage adapter.
 *
 * Only the configured R2 public origin and the private lead-documents bucket
 * prefix are accepted. This deliberately does not turn arbitrary URLs into
 * storage keys: the caller still gets a tenant-bound path or null.
 */
export function normalizeLeadDocumentStoragePath(
  rawPath: string,
  tenantId: string,
  r2PublicBaseUrl: string | undefined,
): string | null {
  const expectedPrefix = `${tenantId}/`;
  if (rawPath.startsWith(expectedPrefix) && !rawPath.includes("..")) return rawPath;
  if (!r2PublicBaseUrl) return null;

  try {
    const actual = new URL(rawPath);
    const trusted = new URL(r2PublicBaseUrl);
    if (actual.origin !== trusted.origin) return null;

    const bucketPrefix = `/${LEAD_DOCUMENT_BUCKET}/`;
    if (!actual.pathname.startsWith(bucketPrefix)) return null;
    const relative = decodeURIComponent(actual.pathname.slice(bucketPrefix.length));
    if (!relative.startsWith(expectedPrefix) || relative.includes("..")) return null;
    return relative;
  } catch {
    return null;
  }
}
