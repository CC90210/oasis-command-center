/**
 * lib/tenant/tenant-asset-response.ts - the answer of the public route
 * GET /api/tenant-assets/<tenant>/<file> (app/api/tenant-assets/[...path]).
 *
 * A workspace's logo and an offer page's thumbnail are written to the ONE R2
 * bucket under the `tenant-assets` prefix, which lib/r2-storage.ts lists as
 * public (PUBLIC_BUCKET_PREFIXES). The bucket itself is private (it holds
 * merchant bank statements), so a public page cannot load those objects from
 * R2 directly: this route reads them server-side and hands the bytes back. See
 * lib/tenant/logo-url.ts for the incident.
 *
 * What it refuses, each with the same 404 so it tells nobody what exists:
 *   - any path that is not `<tenant uuid>/<file>` (or one folder deeper), in
 *     the charset the uploaders write (tenantAssetPathFromSegments). The bucket
 *     prefix is fixed here: no other prefix can be named, so a request can
 *     never reach lead-documents or any other private object.
 *   - anything over MAX_ASSET_BYTES.
 *   - anything that is not, by its own first bytes, a PNG, JPEG, GIF or WebP.
 *     The upload route only accepts those four, and sniffing (never trusting a
 *     stored type or a file name) means even a stray HTML or SVG object in the
 *     prefix is never served as a document.
 *
 * The response is an inert image: its own sniffed type, nosniff, and a
 * Content-Security-Policy that forbids everything, in case it is ever opened
 * directly. A store that is not configured or fails answers 503 (no-store), so
 * a broken store is never cached as "not found".
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import { tenantAssetPathFromSegments } from "@/lib/tenant/logo-url";

/** The R2 key prefix this route reads. Fixed: never taken from the request. */
export const TENANT_ASSET_BUCKET = "tenant-assets";

/** Logos are capped at 2 MB on upload; thumbnails are smaller. Anything bigger is refused. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/** Objects are written under a new name per upload (a timestamp), so a day of caching is safe. */
export const ASSET_CACHE_CONTROL = "public, max-age=86400";

type Download = (bucket: string, path: string) => Promise<{ data: Blob | null; error: { message?: string; status?: number } | null }>;

/** The image type the bytes themselves say they are, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return "image/gif";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const notFound = () =>
  new Response(null, { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

const unavailable = () =>
  new Response(null, { status: 503, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * The route's whole answer for the path segments after /api/tenant-assets/.
 * `download` is the object store's download (lib/r2-storage.ts in production).
 */
export async function tenantAssetResponse(segments: readonly string[], download: Download): Promise<Response> {
  const path = tenantAssetPathFromSegments(segments);
  if (!path) return notFound();

  let got: Awaited<ReturnType<Download>>;
  try {
    got = await download(TENANT_ASSET_BUCKET, path);
  } catch (err) {
    console.error("[tenant-assets] object store unavailable", { error: err instanceof Error ? err.message : String(err) });
    return unavailable();
  }
  if (got.error || !got.data) {
    // R2 answers 404 for a key that is not there: that is the visitor's 404.
    // Anything else is the store failing, never cached as "not found".
    if (got.error?.status === 404) return notFound();
    console.error("[tenant-assets] download failed", { status: got.error?.status ?? null });
    return unavailable();
  }
  if (got.data.size > MAX_ASSET_BYTES) return notFound();
  const bytes = new Uint8Array(await got.data.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) return notFound();
  const type = sniffImageType(bytes);
  if (!type) return notFound();
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(bytes.byteLength),
      "cache-control": ASSET_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
