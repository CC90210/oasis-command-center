/**
 * extracted-videos - what Content > Extracted videos shows for one video the
 * Video extractor (Content Tools) saved.
 *
 * CC, 2026-10-17: "there needs to be a video extractor - that's perfect - but it
 * should get stored in a separate category, like extracted videos or whatever,
 * rather than the main library."
 *
 * WHERE THEY LIVE. The runner writes each video as a marketing_asset under brand
 * `downloads` (lib/tools/runner-handlers.ts), status draft, rights unknown:
 * someone else's work, kept for reference. They used to sit in the Library as a
 * "Downloads" tab. Now they have their own page, app/founders/marketing/extracted,
 * and the Library has no Downloads tab (LIBRARY_BRAND_GROUPS in
 * lib/founders-marketing-core.ts). The rows did not move: the page reads the same
 * `downloads` group through loadLibraryPage, so nothing was migrated and a video
 * extracted before this change shows here too.
 *
 * PURE: no React, no server imports, so tests/extracted-videos.test.ts runs it
 * with no session and no database. The facts come from the asset's `meta`, which
 * the runner's /complete writes (meta.source, meta.file); anything missing or the
 * wrong shape reads as null, so an older row still renders.
 */

export const EXTRACTED_ROOT = "/founders/marketing/extracted";

/** The brand group the extractor writes under (lib/founders-marketing-core.ts BRAND_GROUPS). */
export const EXTRACTED_BRAND_GROUP = "downloads" as const;

/** The element id of one video's card, so a link can land on it. */
export function extractedAnchor(assetId: string): string {
  return `video-${assetId}`;
}

/** Where "Open in Extracted videos" goes for one finished run. */
export function extractedHref(assetId: string): string {
  return `${EXTRACTED_ROOT}#${extractedAnchor(assetId)}`;
}

export type ExtractedVideoFacts = {
  /** "Instagram", "TikTok", "YouTube", or the platform key as written. */
  platform: string | null;
  /** "@handle" when the post had one, else the uploader or channel name. */
  creator: string | null;
  creatorUrl: string | null;
  /** The post itself, on its platform. */
  originalUrl: string | null;
  /** The post's own title or caption line. */
  postTitle: string | null;
  /** YYYY-MM-DD, from yt-dlp's YYYYMMDD. */
  postedOn: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  hasAudio: boolean | null;
  bytes: number | null;
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  twitter: "X",
  facebook: "Facebook",
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Only a real web address becomes a link: a stored value is never trusted as a URL. */
function webUrl(v: unknown): string | null {
  const t = text(v, 2048);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** `meta` as an object, whatever shape the driver handed back. Never throws. */
export function parseMeta(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return obj(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return obj(raw);
}

export function extractedVideoFacts(rawMeta: unknown): ExtractedVideoFacts {
  const meta = parseMeta(rawMeta);
  const source = obj(meta.source);
  const file = obj(meta.file);
  const metrics = obj(source.metrics);
  const key = text(source.platform, 40)?.toLowerCase() ?? null;
  const handle = text(source.handle, 120)?.replace(/^@+/, "") ?? null;
  const date = text(source.upload_date, 8);
  return {
    platform: key ? (PLATFORM_LABELS[key] ?? key) : null,
    creator: handle ? `@${handle}` : (text(source.uploader, 120) ?? text(source.channel, 120)),
    creatorUrl: webUrl(source.uploader_url),
    originalUrl: webUrl(source.webpage_url) ?? webUrl(source.url),
    postTitle: text(source.title, 300),
    postedOn: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
    views: count(metrics.view_count),
    likes: count(metrics.like_count),
    comments: count(metrics.comment_count),
    hasAudio: typeof file.has_audio === "boolean" ? file.has_audio : null,
    bytes: count(file.bytes),
  };
}

/** 5_109_047 -> "4.9 MB". */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 25.15 -> "0:25"; 3725 -> "1:02:05". */
export function formatDuration(seconds: number | string | null | undefined): string | null {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const whole = Math.round(s);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 12400 -> "12.4K". */
export function formatCount(n: number | null): string | null {
  if (n === null) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
