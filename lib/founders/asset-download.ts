/**
 * Which file a Library "Download" hands over, and what it is called on disk.
 *
 * CC, 2026-10-16: "I want to be able to download the actual videos to my computer
 * ... all the videos in the library section in content." The Library could only
 * PLAY media: every URL it rendered was signed for inline viewing, so saving one
 * meant a right-click on a video element, if the browser offered it at all.
 *
 * Pure, so the choice and the name are tested without R2 or a database. The route
 * (app/api/founders/marketing/assets/[id]/download) signs whatever this picks with
 * `Content-Disposition: attachment`, which is what makes the browser save it.
 */
import { parseSlideUrls } from "@/lib/founders-marketing-core";

/** The one place the download URL is spelled, for every button that offers it. */
export function assetDownloadHref(assetId: string, slide?: number | null): string {
  const base = `/api/founders/marketing/assets/${encodeURIComponent(assetId)}/download`;
  return slide ? `${base}?slide=${slide}` : base;
}

export type DownloadMediaRow = {
  kind: string;
  storage_bucket: string;
  storage_path: string;
};

/**
 * The original the operator means by "download this asset":
 *   - a carousel with `slide` (1-based): that slide, in the recorded order;
 *   - anything else: the video if there is one, else slide 1 (the cover), else
 *     the first image. The Library poster is never the answer for a video.
 * Returns null when nothing downloadable is attached or the slide does not exist.
 */
export function pickDownloadMedia(
  rows: readonly DownloadMediaRow[],
  mediaUrls: unknown,
  slide?: number | null,
): DownloadMediaRow | null {
  const byPath = new Map(rows.map((r) => [r.storage_path, r]));
  // media_urls is the only record of slide order (the media rows carry no rank).
  const ordered = parseSlideUrls(mediaUrls)
    .map((p) => byPath.get(p))
    .filter((r): r is DownloadMediaRow => Boolean(r));

  if (slide != null) {
    if (!Number.isInteger(slide) || slide < 1) return null;
    return ordered[slide - 1] ?? null;
  }
  return (
    rows.find((r) => r.kind === "video") ??
    ordered[0] ??
    rows.find((r) => r.kind === "image") ??
    null
  );
}

/**
 * "OASIS FLEET VSL (16:9, George) - A tool waits" + ".../1786_x_pillar-fleet.mp4"
 *   -> "OASIS-FLEET-VSL-169-George-A-tool-waits.mp4"
 * Plain ASCII only: the name travels inside a quoted Content-Disposition value.
 */
export function downloadFilename(
  title: string | null | undefined,
  storagePath: string,
  slide?: number | null,
): string {
  const ext = /\.([A-Za-z0-9]{2,5})$/.exec(storagePath)?.[1]?.toLowerCase() ?? "bin";
  const base =
    (title ?? "")
      .replace(/[^A-Za-z0-9 _-]+/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90)
      .replace(/-$/, "") || "oasis-asset";
  return `${base}${slide ? `-slide-${slide}` : ""}.${ext}`;
}
