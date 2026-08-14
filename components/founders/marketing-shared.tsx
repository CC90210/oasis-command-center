/**
 * Presentational pieces shared by the Marketing surfaces.
 *
 * Pure calc lives in lib/founders-marketing-core.ts — keep it out of this file. Mixing
 * the two makes Next treat the calc helpers as client references and the page
 * crashes at render (same lesson as components/renewals/renewals-shared.tsx).
 */

import Link from "next/link";

import { Tag } from "@/components/Card";
import { AssetActions } from "@/components/founders/AssetActions";
import { CarouselFrame } from "@/components/founders/CarouselFrame";
import {
  channelLabel,
  isRenderableCarousel,
  parsePlatforms,
  platformLabel,
  fmtDuration,
  type AssetStatus,
  type Channel,
} from "@/lib/founders-marketing-core";

type Tone = "neutral" | "accent" | "hot" | "warm" | "engaged" | "info";

const STATUS_TONE: Record<AssetStatus, Tone> = {
  draft: "neutral",
  in_review: "warm",
  approved: "accent",
  scheduled: "info",
  published: "engaged",
  rejected: "hot",
  archived: "neutral",
};

/**
 * The box an asset is shown in — ONE definition, used by the tile and the detail
 * page.
 *
 * Every asset used to sit in an `aspect-video` box with `object-cover`. Cover
 * means fill AND CROP, so a 1080x1920 film rendered as a magnified middle band —
 * CC: *"it is collapsed for some reason… It's super zoomed in, and I'm not able
 * to see anything."*
 *
 * MEASURED PIXELS BEAT THE LABEL. `aspect` is a declared string and can be wrong
 * or missing; width/height come from the stored media. The label is the fallback,
 * not the source of truth.
 *
 * Exported because the detail page needs exactly this and a second copy would
 * drift — Maven's note on the tile said it plainly: "when the detail route
 * exists, it must IMPORT this frame logic rather than restate it, or the crop
 * comes back on one page only." It had already been restated once.
 */
export function mediaFrame(
  mediaW?: number | null,
  mediaH?: number | null,
  aspect?: string | null,
): { className: string; style: React.CSSProperties | undefined } {
  // Sanity band: anything outside 1:5..5:1 is a corrupt row, not a shape to honour.
  const r = mediaW && mediaH && mediaW > 0 && mediaH > 0 ? mediaW / mediaH : null;
  const measured = r && r >= 0.2 && r <= 5 ? `${mediaW} / ${mediaH}` : null;
  return measured
    ? { className: "", style: { aspectRatio: measured } }
    : { className: FRAME[aspect || ""] || "aspect-video", style: undefined };
}

/** True when the asset is taller than it is wide — the detail page lays out around this. */
export function isPortrait(mediaW?: number | null, mediaH?: number | null): boolean {
  return Boolean(mediaW && mediaH && mediaH > mediaW);
}

export function StatusTag({ status }: { status: AssetStatus }) {
  return <Tag tone={STATUS_TONE[status] ?? "neutral"}>{status.replace("_", " ")}</Tag>;
}

/**
 * The frame an asset is shown in, derived from the asset's OWN aspect.
 *
 * CC, 2026-08-14, watching a 9:16 film from this grid: *"it is collapsed for some
 * reason… It's super zoomed in, and I'm not able to see anything. This is exactly what
 * I didn't want!"*
 *
 * He was right and it was this component. Every tile was `aspect-video` (16:9) and every
 * video was `object-cover`. Cover means FILL AND CROP, so a 1080x1920 film rendered as a
 * zoomed middle band — in the grid and, because object-fit still applies there, in
 * fullscreen too. The bytes were never wrong; the frame around them was.
 *
 * (Not the same defect as e4f0e17, which was the marketing shell freezing across a soft
 * nav. That one made a PAGE look zoomed. This one crops the VIDEO.)
 *
 * Three rules now:
 *   - the box takes the MEASURED shape of the media (width/height, probed off the file)
 *     and falls back to the `aspect` label only when the pixels are missing or absurd.
 *     The label is what someone wrote down; the pixels are what the file is. An audit of
 *     this surface found the label had already drifted once — a 1080x1350 card stored as
 *     "9:16" — and a drifted label renders a vertical film as a ~92px sliver;
 *   - `object-contain`, always. A library exists to show you what you made; cropping a
 *     deliverable to keep a grid tidy is the tail wagging the dog;
 *   - the ratio goes in an INLINE STYLE, never `aspect-[${w}/${h}]`. Tailwind emits only
 *     classes it can find as literal text, so an interpolated one is never generated, the
 *     div loses its only height source and EVERY tile collapses to nothing.
 */
const FRAME: Record<string, string> = {
  "9:16": "aspect-[9/16]",
  "4:5": "aspect-[4/5]",
  "1:1": "aspect-square",
  "16:9": "aspect-video",
};

/**
 * One library tile. `playbackUrl` is a short-lived signed Storage URL resolved
 * server-side — the browser never receives a service key.
 */
export function AssetTile({
  id,
  title,
  brandName,
  channel,
  status,
  hook,
  aspect,
  durationS,
  playbackUrl,
  posterUrl,
  mediaW,
  mediaH,
  format,
  platforms: platformsRaw,
  assetType,
  slideUrls,
  openReviews = 0,
}: {
  id: string;
  title: string;
  brandName: string;
  channel: Channel;
  status: AssetStatus;
  hook?: string | null;
  aspect?: string | null;
  durationS?: number | null;
  playbackUrl?: string | null;
  posterUrl?: string | null;
  mediaW?: number | null;
  mediaH?: number | null;
  format: string;
  platforms?: string[] | string | null;
  assetType?: string | null;
  /** Signed URLs, already in slide order. */
  slideUrls?: string[];
  openReviews?: number;
}) {
  const duration = fmtDuration(durationS);
  const { className: frame, style: frameStyle } = mediaFrame(mediaW, mediaH, aspect);
  const platforms = parsePlatforms(platformsRaw);
  const slides = slideUrls ?? [];
  return (
    <article className="rounded-xl border border-bg-border bg-bg-panel shadow-card overflow-hidden transition-all hover:border-accent/40 hover:shadow-ironman group">
      <div
        className={`relative ${frame} bg-bg-deep flex items-center justify-center overflow-hidden`}
        style={frameStyle}
      >
        {isRenderableCarousel(assetType, slides) ? (
          // One card, N slides. Before the slides were registered this row
          // rendered as an isolated image whose artwork said "01/05 · swipe →".
          <CarouselFrame slides={slides} title={title} className="h-full w-full" />
        ) : playbackUrl && format === "video" ? (
          // preload="metadata" so a 200-tile library does not pull 200 videos.
          <video
            src={playbackUrl}
            poster={posterUrl || undefined}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
          />
        ) : posterUrl ? (
          // Plain <img> on purpose. next/image would need a matching
          // remotePatterns entry for the Storage host, and it re-fetches the
          // source server-side through the optimizer — an extra round trip on a
          // URL that is deliberately short-lived. The optimizer CAN read the
          // object (the signature is in the query string), but its cached
          // derivative outlives the signature, so a re-optimize after expiry
          // fails while the tile still looks cached. Not worth it for a poster.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="px-4 text-center text-xs text-fg-dim">
            {format === "html"
              ? "HTML page"
              : format === "video"
                ? "no render on file yet"
                : "no preview"}
          </div>
        )}
        {aspect && (
          <span className="absolute left-2 top-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tracking-wider text-fg-muted">
            {aspect}
          </span>
        )}
        {duration && (
          <span className="absolute bottom-2 right-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tabular-nums text-fg-muted">
            {duration}
          </span>
        )}
        {openReviews > 0 && (
          <span
            className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent shadow-glow"
            aria-label={`${openReviews} unread review${openReviews === 1 ? "" : "s"}`}
          />
        )}
      </div>

      <div className="flex flex-col gap-2 p-4">
        <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-accent">
          {brandName}
        </span>
        {/* A link again: /founders/marketing/asset/[id] now EXISTS. It was
            specified, linked, and never built, so every title in this grid was a
            404 — the link was removed to stop it lying. The page imports
            mediaFrame() from this file rather than restating it, which was the
            condition attached to restoring this. */}
        <Link
          href={`/founders/marketing/asset/${id}`}
          className="text-sm font-medium text-fg line-clamp-2 hover:text-accent transition-colors"
        >
          {title}
        </Link>
        {hook && <p className="text-xs text-fg-muted line-clamp-2 italic">{hook}</p>}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-fg-dim font-bold">
            {/* The real distribution when we have it, the primary channel when we
                do not. Showing `channel` alone is what made every tile read
                INSTAGRAM regardless of where the piece actually went. */}
            {platforms.length > 0
              ? platforms.map(platformLabel).join(" · ")
              : channelLabel(channel)}
          </span>
          <StatusTag status={status} />
        </div>
        {/* The verdict lives on the tile. Sending the operator somewhere else to approve
            something they are already looking at is how 39 assets ended up sitting in
            review with no way to clear them. */}
        <AssetActions id={id} status={status} title={title} />
      </div>
    </article>
  );
}

/**
 * Honest empty state. Says what is missing AND what to do, because a dashboard
 * that shows nothing without a next action is one people stop opening.
 */
export function MarketingEmpty({
  headline,
  detail,
  hint,
}: {
  headline: string;
  detail: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-bg-border bg-bg-deep/30 px-6 py-12 text-center">
      <div className="text-base font-semibold text-fg">{headline}</div>
      <p className="mx-auto mt-2 max-w-lg text-sm text-fg-muted leading-relaxed">{detail}</p>
      {hint && (
        <p className="mx-auto mt-3 max-w-lg text-xs text-fg-dim font-mono leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}
