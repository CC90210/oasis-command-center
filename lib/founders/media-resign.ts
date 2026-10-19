/**
 * A fresh signed link for one Library media object whose link stopped working.
 *
 * WHY THIS EXISTS
 * CC, 2026-10-19 (through Maven): Library quote cards kept showing the browser's
 * broken-image icon. The server side was proven clean (the rows, the R2 objects,
 * the Worker's own signed links all answered 200 image/png), and the tile was a
 * plain lazy <img> of a link that lives one to two hours. A Library tab left open
 * past that, or a lazy tile scrolled to later, asks R2 with an expired signature
 * and gets a 403: the broken icon, with nothing to recover it but a reload.
 *
 * So a tile that fails hands its link back here (POST /api/founders/marketing/media/resign)
 * and gets one fresh link to retry with (components/founders/SignedMedia.tsx).
 *
 * WHAT IS SIGNED, AND FOR WHOM
 * Never "whatever key the caller names". The link is parsed back to its object
 * (bucket + path), and that object must be media of one of THIS workspace's
 * Library assets: a marketing_asset_media row, or a carousel slide listed in an
 * asset's media_urls (slides live in marketing-media; loadLibraryPage signs them
 * from there). Anything else is "not found", the same answer as a link that does
 * not parse, so the route confirms nothing about other workspaces' objects.
 */
import type { Client } from "@libsql/client";

import { parseSlideUrls } from "@/lib/founders-marketing-core";

export type MediaRef = { bucket: string; path: string };

/** The bucket slides are signed from (lib/founders/marketing-queries.ts loadLibraryPage). */
export const SLIDE_BUCKET = "marketing-media";

/** The Library's own lifetime for a playback link (signMediaUrls' default). */
export const RESIGN_TTL_SEC = 60 * 60;

/** A signed R2 link is a few hundred characters; anything far longer is not one. */
export const MAX_SIGNED_URL_CHARS = 4096;

const R2_HOST_SUFFIX = ".r2.cloudflarestorage.com";

/**
 * `https://<account>.r2.cloudflarestorage.com/<R2 bucket>/<bucket>/<path>?X-Amz-...`
 * back to `{ bucket, path }`, or null for anything that is not one of this
 * Worker's own signed links (lib/r2-storage.ts presign: the one R2 bucket, then
 * the Supabase bucket name as the key prefix, each segment RFC 3986 encoded).
 */
export function mediaRefFromSignedUrl(raw: unknown, r2Bucket: string | undefined): MediaRef | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_SIGNED_URL_CHARS || !r2Bucket) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(R2_HOST_SUFFIX)) return null;
  let segments: string[];
  try {
    segments = url.pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segments.length < 3 || segments[0] !== r2Bucket) return null;
  if (segments.some((s) => !s || s === "." || s === "..")) return null;
  const [, bucket, ...rest] = segments;
  return { bucket, path: rest.join("/") };
}

/** Whether `ref` is media of one of this workspace's Library assets. Tenant-scoped; read-only. */
export async function isTenantLibraryMedia(db: Pick<Client, "execute">, tenantId: string, ref: MediaRef): Promise<boolean> {
  if (!tenantId) return false;
  const media = await db.execute({
    sql: `SELECT 1 FROM marketing_asset_media
          WHERE tenant_id = ? AND storage_bucket = ? AND storage_path = ? LIMIT 1`,
    args: [tenantId, ref.bucket, ref.path],
  });
  if (media.rows.length) return true;
  if (ref.bucket !== SLIDE_BUCKET) return false;
  // instr narrows the read; the exact match on the parsed list decides, so a path
  // that is only a substring of a listed one never counts.
  const slides = await db.execute({
    sql: `SELECT media_urls FROM marketing_asset
          WHERE tenant_id = ? AND instr(media_urls, ?) > 0 LIMIT 20`,
    args: [tenantId, ref.path],
  });
  return slides.rows.some((row) => parseSlideUrls(row.media_urls).includes(ref.path));
}
