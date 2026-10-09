/**
 * lib/offer-pages/video.ts - the server side of an offer page's video.
 *
 * LIBRARY VIDEO (design section 4.1). Files live in the PRIVATE R2 prefix
 * marketing-media (never public/: tests/no-public-media.test.ts). A Library
 * ref resolves only when, for the FORM'S OWN workspace:
 *   - the asset exists in that workspace (every statement binds tenant_id),
 *   - it is OASIS's own brand (never a client brand's asset: MKT-01),
 *   - it is not archived or rejected, and is a video,
 *   - the media row is that asset's, of the right kind (video / poster /
 *     caption).
 * The page's HTML carries the poster only, signed through the existing
 * windowed presign. The video itself is signed on tap by
 * /api/offer-page/video, which resolves the ref again from the PUBLISHED copy.
 *
 * LINK VIDEO (section 4.2). The provider's oEmbed gives the title, the
 * thumbnail and (Vimeo) the length; the thumbnail is copied into our public
 * tenant-assets prefix so the page makes no third-party request before a tap.
 *
 * Signing and uploading are passed in, so this runs against a local libSQL
 * file in tests with no storage at all. ASCII only.
 */
import type { Client, ResultSet } from "@libsql/client";
import { FOUNDERS_OWN_BRAND } from "@/lib/founders-marketing-core";
import type { ImageRef, LibraryVideoRef, LinkVideoRef, OfferPageDoc, VideoRef } from "./types";
import { parseOfferPageDoc } from "./types";
import { canonicalUrl, findVideoRef, videoRefs } from "./providers";
import { isMissingOfferTable, noteOfferTableMissing } from "./store";

export type MediaRow = {
  id: string;
  asset_id: string;
  kind: string;
  storage_bucket: string;
  storage_path: string;
  mime: string | null;
  width: number | null;
  height: number | null;
};

export type AssetRow = {
  id: string;
  brand_slug: string;
  format: string;
  status: string;
  title: string;
  duration_s: number | null;
  aspect: string | null;
};

export type ResolvedVideo = { asset: AssetRow; video: MediaRow; poster: MediaRow | null; caption: MediaRow | null };

/** Library media the page may show, by ref (videos) and by "asset|media" (images). */
export type ResolvedLibrary = { videos: Map<string, ResolvedVideo>; images: Map<string, MediaRow> };

/** signMediaUrls' shape (lib/founders/marketing-queries.ts): "bucket\npath" -> url. */
export type Signer = (refs: Array<{ bucket: string; path: string }>, ttlSec: number) => Promise<Map<string, string>>;

const BLOCKED_STATUSES = new Set(["archived", "rejected"]);
const POSTER_KINDS = new Set(["poster", "thumb", "preview", "image"]);
const IMAGE_KINDS = new Set(["image", "poster", "thumb", "preview"]);

/** The page's poster: an hour, plus the presign window (a stable URL the browser can cache). */
export const POSTER_TTL_SEC = 60 * 60;
/** The video itself, signed on tap: two hours, plus the window. */
export const PLAY_TTL_SEC = 2 * 60 * 60;

function rowsOf(rs: ResultSet): Array<Record<string, unknown>> {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o;
  });
}

const num = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export function mediaKey(bucket: string, path: string): string {
  return `${bucket}\n${path}`;
}

export function imageKey(image: ImageRef): string {
  return `${image.asset_id}|${image.media_id}`;
}

function isMissingLibrary(err: unknown): boolean {
  return /no such table:\s*"?marketing_asset/i.test(err instanceof Error ? err.message : String(err));
}

/** Is this asset one the page may show at all? */
function assetAllowed(a: AssetRow | undefined): a is AssetRow {
  return !!a && a.brand_slug === FOUNDERS_OWN_BRAND && !BLOCKED_STATUSES.has(a.status);
}

/**
 * Resolve Library video refs and images for ONE workspace. Anything that does
 * not pass every check is simply absent from the result: the page then does not
 * draw it, and the signing route answers 404.
 */
export async function resolveLibrary(
  db: Client,
  tenantId: string,
  videos: Array<{ ref: string; video: LibraryVideoRef }>,
  images: ImageRef[] = [],
): Promise<ResolvedLibrary> {
  const out: ResolvedLibrary = { videos: new Map(), images: new Map() };
  const assetIds = [...new Set([...videos.map((v) => v.video.asset_id), ...images.map((i) => i.asset_id)])];
  if (!assetIds.length) return out;
  const marks = assetIds.map(() => "?").join(", ");
  let assets: Map<string, AssetRow>;
  let media: Map<string, MediaRow>;
  try {
    const [a, m] = await Promise.all([
      db.execute({
        sql: `SELECT id, brand_slug, format, status, title, duration_s, aspect FROM marketing_asset
              WHERE tenant_id = ? AND id IN (${marks})`,
        args: [tenantId, ...assetIds],
      }),
      db.execute({
        sql: `SELECT id, asset_id, kind, storage_bucket, storage_path, mime, width, height FROM marketing_asset_media
              WHERE tenant_id = ? AND asset_id IN (${marks})`,
        args: [tenantId, ...assetIds],
      }),
    ]);
    assets = new Map(
      rowsOf(a).map((r) => [
        String(r.id),
        {
          id: String(r.id),
          brand_slug: String(r.brand_slug ?? ""),
          format: String(r.format ?? ""),
          status: String(r.status ?? ""),
          title: String(r.title ?? ""),
          duration_s: num(r.duration_s),
          aspect: r.aspect == null ? null : String(r.aspect),
        },
      ]),
    );
    media = new Map(
      rowsOf(m).map((r) => [
        String(r.id),
        {
          id: String(r.id),
          asset_id: String(r.asset_id),
          kind: String(r.kind ?? ""),
          storage_bucket: String(r.storage_bucket ?? "marketing-media"),
          storage_path: String(r.storage_path ?? ""),
          mime: r.mime == null ? null : String(r.mime),
          width: num(r.width),
          height: num(r.height),
        },
      ]),
    );
  } catch (err) {
    if (isMissingLibrary(err)) return out;
    throw err;
  }
  const own = (id: string | undefined, assetId: string, kinds: Set<string>): MediaRow | null => {
    if (!id) return null;
    const row = media.get(id);
    return row && row.asset_id === assetId && kinds.has(row.kind) && row.storage_path ? row : null;
  };
  for (const { ref, video } of videos) {
    const asset = assets.get(video.asset_id);
    if (!assetAllowed(asset) || asset.format !== "video") continue;
    const v = own(video.video_media_id, asset.id, new Set(["video"]));
    if (!v) continue;
    out.videos.set(ref, {
      asset,
      video: v,
      poster: own(video.poster_media_id, asset.id, POSTER_KINDS),
      caption: own(video.caption_media_id, asset.id, new Set(["caption"])),
    });
  }
  for (const image of images) {
    const asset = assets.get(image.asset_id);
    if (!assetAllowed(asset)) continue;
    const row = own(image.media_id, asset.id, IMAGE_KINDS);
    if (row) out.images.set(imageKey(image), row);
  }
  return out;
}

/** Every Library video and image a document would draw, resolved for its workspace. */
export async function resolveDocLibrary(db: Client, tenantId: string, doc: OfferPageDoc): Promise<ResolvedLibrary> {
  const videos = videoRefs(doc).filter((v): v is { ref: string; video: VideoRef & LibraryVideoRef } => v.video.source === "library");
  const images: ImageRef[] = [];
  for (const s of doc.sections) {
    if (s.key !== "results") continue;
    for (const it of s.items) if (it.kind === "screenshot") images.push(it.image);
  }
  return resolveLibrary(db, tenantId, videos, images);
}

/**
 * Signed URLs for what the page's HTML may carry: posters and result images.
 * Never the video files.
 */
export async function signPageMedia(
  resolved: ResolvedLibrary,
  sign: Signer,
): Promise<{ posters: Map<string, string>; images: Map<string, string> }> {
  const refs: Array<{ bucket: string; path: string }> = [];
  for (const v of resolved.videos.values()) if (v.poster) refs.push({ bucket: v.poster.storage_bucket, path: v.poster.storage_path });
  for (const m of resolved.images.values()) refs.push({ bucket: m.storage_bucket, path: m.storage_path });
  let urls = new Map<string, string>();
  if (refs.length) {
    try {
      urls = await sign(refs, POSTER_TTL_SEC);
    } catch (err) {
      console.error("[offer-pages] poster signing failed; posters omitted", err instanceof Error ? err.message : String(err));
    }
  }
  const posters = new Map<string, string>();
  for (const [ref, v] of resolved.videos) {
    const u = v.poster ? urls.get(mediaKey(v.poster.storage_bucket, v.poster.storage_path)) : undefined;
    if (u) posters.set(ref, u);
  }
  const images = new Map<string, string>();
  for (const [key, m] of resolved.images) {
    const u = urls.get(mediaKey(m.storage_bucket, m.storage_path));
    if (u) images.set(key, u);
  }
  return { posters, images };
}

export type PublishedVideo =
  | { ok: true; tenantId: string; resolved: ResolvedVideo }
  | { ok: false; reason: "not_found" };

/**
 * The Library video at `ref`, ONLY if it is in the PUBLISHED copy of a LIVE
 * offer page on an ENABLED form, and resolves for that form's own workspace.
 * Everything else, a draft-only ref included, is not_found.
 */
export async function resolvePublishedVideo(db: Client, formId: string, ref: string): Promise<PublishedVideo> {
  let row: Record<string, unknown> | undefined;
  try {
    row = rowsOf(
      await db.execute({
        sql: `SELECT f.tenant_id, f.enabled, o.published, o.live
              FROM forms f JOIN form_offer_pages o ON o.form_id = f.id AND o.tenant_id = f.tenant_id
              WHERE f.id = ? LIMIT 1`,
        args: [formId],
      }),
    )[0];
  } catch (err) {
    if (isMissingOfferTable(err)) {
      noteOfferTableMissing("video");
      return { ok: false, reason: "not_found" };
    }
    throw err;
  }
  if (!row || Number(row.enabled) !== 1 || Number(row.live) !== 1 || row.published == null) return { ok: false, reason: "not_found" };
  let doc: OfferPageDoc;
  try {
    doc = parseOfferPageDoc(String(row.published));
  } catch {
    return { ok: false, reason: "not_found" };
  }
  const video = findVideoRef(doc, ref);
  if (!video || video.source !== "library") return { ok: false, reason: "not_found" };
  const tenantId = String(row.tenant_id);
  const resolved = await resolveLibrary(db, tenantId, [{ ref, video }]);
  const hit = resolved.videos.get(ref);
  return hit ? { ok: true, tenantId, resolved: hit } : { ok: false, reason: "not_found" };
}

// ---------------------------------------------------------------------------
// Link videos: oEmbed and our copy of the thumbnail
// ---------------------------------------------------------------------------

/** Hosts a provider's thumbnail may come from. Anything else is not fetched. */
export const THUMB_HOSTS: ReadonlySet<string> = new Set(["i.ytimg.com", "img.youtube.com", "i.vimeocdn.com", "cdn.loom.com"]);

const THUMB_MAX_BYTES = 1_500_000;
const THUMB_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function oembedUrl(ref: Pick<LinkVideoRef, "source" | "id" | "hash">): string {
  const page = encodeURIComponent(canonicalUrl(ref));
  if (ref.source === "youtube") return `https://www.youtube.com/oembed?format=json&url=${page}`;
  if (ref.source === "vimeo") return `https://vimeo.com/api/oembed.json?url=${page}`;
  return `https://www.loom.com/v1/oembed?url=${page}`;
}

export type LinkMetadata = { title?: string; thumbnailUrl?: string; durationS?: number };

/** The provider's title, thumbnail and length. Best effort: {} on any failure. */
export async function fetchLinkMetadata(
  ref: Pick<LinkVideoRef, "source" | "id" | "hash">,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkMetadata> {
  try {
    const res = await fetchImpl(oembedUrl(ref), { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!res.ok) return {};
    const data = (await res.json()) as Record<string, unknown>;
    const out: LinkMetadata = {};
    if (typeof data.title === "string" && data.title.trim()) {
      out.title = data.title.replace(/[\u0000-\u001F\u007F<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    }
    if (typeof data.thumbnail_url === "string") {
      try {
        const u = new URL(data.thumbnail_url);
        if (u.protocol === "https:" && THUMB_HOSTS.has(u.hostname)) out.thumbnailUrl = u.toString();
      } catch {
        // not a URL: no thumbnail
      }
    }
    if (typeof data.duration === "number" && Number.isFinite(data.duration) && data.duration > 0) {
      out.durationS = Math.round(data.duration);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Copy the provider's thumbnail into the public tenant-assets prefix, so the
 * page shows it without a third-party request. Returns the stored path, or
 * null (the facade then shows a plain play button).
 */
export async function copyThumbnail(input: {
  thumbnailUrl: string;
  tenantId: string;
  ref: Pick<LinkVideoRef, "source" | "id">;
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  try {
    const u = new URL(input.thumbnailUrl);
    if (u.protocol !== "https:" || !THUMB_HOSTS.has(u.hostname)) return null;
    // Never follow a redirect: the host check above is the only one, and a
    // provider URL that redirects could lead anywhere (an internal address,
    // plain http) before the bytes land in the PUBLIC prefix. A 3xx is not ok.
    const res = await (input.fetchImpl ?? fetch)(u.toString(), { signal: AbortSignal.timeout(5000), redirect: "manual" });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = THUMB_TYPES[type];
    if (!ext) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > THUMB_MAX_BYTES) return null;
    const path = `${input.tenantId}/offer-pages/${input.ref.source}-${input.ref.id}.${ext}`;
    return (await input.upload(path, bytes, type)) ? path : null;
  } catch {
    return null;
  }
}

/** A stored thumbnail path, only if it is this workspace's own offer-pages object. */
export function ownThumbPath(tenantId: string, path: string | undefined): string | null {
  return path && path.startsWith(`${tenantId}/offer-pages/`) && !path.includes("..") ? path : null;
}
