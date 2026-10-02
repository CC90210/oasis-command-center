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
import { EnlargeButton, PhoneEnlarge } from "@/components/founders/PhoneEnlarge";
import { PhoneFrame, PhoneTextCard, type PhoneFrameShape } from "@/components/founders/PhoneFrame";
import { TileVideo } from "@/components/founders/TileVideo";
import {
  assetHref,
  channelLabel,
  isRenderableCarousel,
  lifecycleLabel,
  lifecycleOf,
  type Lifecycle,
  type LibraryView,
  parsePlatforms,
  phoneChromeFor,
  platformLabel,
  fmtDuration,
  type AssetStatus,
  type Channel,
} from "@/lib/founders-marketing-core";

type Tone = "neutral" | "accent" | "hot" | "warm" | "engaged" | "info";

/**
 * Badge colour, keyed by LIFECYCLE so it can never contradict the word beside it.
 *
 * Replaced a map keyed by the raw `status` column. Once the label came from
 * lifecycle, that map coloured "Posted" with in_review's amber the moment the two
 * vocabularies disagreed — and they are built to disagree, since library_sync.py
 * stamps in_review on rows that are already public. It read as consistent only
 * because the single published asset also happens to carry status='published'.
 */
const LIFECYCLE_TONE: Record<Lifecycle, Tone> = {
  needs_review: "warm",   // wants something from you
  approved: "accent",     // cleared, not sent
  live: "engaged",        // out in the world
  archived: "neutral",    // shelved, and restorable
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

/**
 * The badge on a tile. Shows the LIFECYCLE bucket, not the raw status column.
 *
 * CC's original complaint was a grid of 41 tiles all reading "IN REVIEW", which
 * told him nothing about whether any of it had gone out. Adding lifecycle pills
 * above the grid while leaving the badges rendering `status` would have left the
 * page speaking two vocabularies at once — pills saying "Posted 1" over a tile
 * still labelled "in review" for the same asset, since library_sync.py stamps
 * in_review on rows that are already public.
 *
 * `published_at` is optional so existing callers keep compiling, and its absence
 * degrades to the review-state reading rather than falsely claiming "Posted".
 */
export function StatusTag({
  status,
  publishedAt,
}: {
  status: AssetStatus;
  publishedAt?: string | null;
}) {
  const bucket = lifecycleOf({ status, published_at: publishedAt ?? null });
  // TONE FOLLOWS THE BUCKET, not the raw column. Taking the label from lifecycle
  // and the colour from `status` renders "Posted" in the amber that means
  // "needs a verdict" the moment those two disagree — and they are DESIGNED to
  // disagree: library_sync.py stamps in_review on rows that are already public,
  // which is the whole reason lifecycle exists. It looks consistent today only
  // because the one published asset also happens to carry status='published'.
  return <Tag tone={LIFECYCLE_TONE[bucket]}>{lifecycleLabel(bucket)}</Tag>;
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

/** What the phone screen says for an asset with nothing to show yet. */
const NO_VISUAL: Record<string, string> = {
  copy: "Text post",
  article: "Article",
  html: "HTML page",
  audio: "Audio",
  video: "Video - no render on file yet",
  image: "Image - no file on record",
  carousel: "Carousel - slides not on file",
};

/**
 * What a tile shows inside its frame, for BOTH presentations.
 *
 * NOTHING HERE LOADS VIDEO. A video is a cover until the viewer presses play
 * (TileVideo mounts the <video> then, preload="none"); images and carousel
 * covers are lazy, async <img>s with their measured width and height, so only
 * the tiles near the viewport fetch anything at all. On 2026-10-01 a Library
 * page fetched every carousel cover and the metadata of every video on arrival.
 */
function TileMedia({
  format,
  assetType,
  slides,
  playbackUrl,
  posterUrl,
  mediaW,
  mediaH,
  title,
  hook,
  phone,
}: {
  format: string;
  assetType?: string | null;
  slides: string[];
  playbackUrl?: string | null;
  posterUrl?: string | null;
  mediaW?: number | null;
  mediaH?: number | null;
  title: string;
  hook?: string | null;
  phone: boolean;
}) {
  if (isRenderableCarousel(assetType, slides)) {
    // One card, N slides. Before the slides were registered this row
    // rendered as an isolated image whose artwork said "01/05 · swipe →".
    return <CarouselFrame slides={slides} title={title} width={mediaW} height={mediaH} className="h-full w-full" />;
  }
  if (playbackUrl && format === "video") {
    return (
      <TileVideo
        src={playbackUrl}
        posterUrl={posterUrl}
        width={mediaW}
        height={mediaH}
        title={title}
        variant={phone ? "phone" : "native"}
      />
    );
  }
  if (posterUrl) {
    return (
      // Plain <img> on purpose. next/image would need a matching
      // remotePatterns entry for the Storage host, and it re-fetches the
      // source server-side through the optimizer — an extra round trip on a
      // URL that is deliberately short-lived. The optimizer CAN read the
      // object (the signature is in the query string), but its cached
      // derivative outlives the signature, so a re-optimize after expiry
      // fails while the tile still looks cached. Not worth it for a poster.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={posterUrl}
        alt=""
        loading="lazy"
        decoding="async"
        width={mediaW ?? undefined}
        height={mediaH ?? undefined}
        className="h-full w-full object-contain"
      />
    );
  }
  // No picture: a text post, an HTML page, or a render that is not on file.
  // On the phone the copy itself is the screen, so a chat-drafted caption is
  // previewable before any media exists.
  if (phone) {
    return <PhoneTextCard kicker={NO_VISUAL[format] ?? "No preview"} text={hook || title} />;
  }
  return (
    <div className="px-4 text-center text-xs text-fg-dim">
      {format === "html"
        ? "HTML page"
        : format === "video"
          ? "no render on file yet"
          : "no preview"}
    </div>
  );
}

/**
 * One library tile. `playbackUrl` is a short-lived signed Storage URL resolved
 * server-side — the browser never receives a service key.
 *
 * `presentation="phone"` (the Library's default) draws the asset inside a
 * PhoneFrame the way it lands on Instagram or TikTok; `"grid"` is the plain
 * card. Both use the same media switch and the same verdict controls.
 *
 * Both open the asset in the big phone (PhoneEnlarge): tapping a video plays it
 * there, and Enlarge opens any asset there without playing it. The big phone
 * always draws the phone's media, so in the grid view it is handed its own.
 */
export function AssetTile({
  id,
  title,
  brandName,
  channel,
  status,
  publishedAt,
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
  presentation = "grid",
  returnTo,
}: {
  id: string;
  title: string;
  brandName: string;
  channel: Channel;
  status: AssetStatus;
  publishedAt?: string | null;
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
  presentation?: LibraryView;
  /** The Library view this tile is drawn in, so the asset page can link back to it. */
  returnTo?: string;
}) {
  const duration = fmtDuration(durationS);
  const platforms = parsePlatforms(platformsRaw);
  const slides = slideUrls ?? [];
  const phone = presentation === "phone";
  const hasVisual = isRenderableCarousel(assetType, slides) || Boolean(posterUrl) || Boolean(playbackUrl && format === "video");
  const mediaProps = { format, assetType, slides, playbackUrl, posterUrl, mediaW, mediaH, title, hook };
  const media = <TileMedia {...mediaProps} phone={phone} />;
  // The big phone draws the phone's media: the tile's own in the phone view,
  // its phone twin in the plain grid.
  const bigMedia = phone ? media : <TileMedia {...mediaProps} phone />;
  const frameShape: PhoneFrameShape = {
    mediaW,
    mediaH,
    aspect,
    handle: brandName,
    caption: hasVisual ? hook : null,
    chrome: phoneChromeFor(null, channel),
  };

  const details = (
    <div className={phone ? "flex flex-col gap-1.5 pt-3" : "flex flex-col gap-2 p-4"}>
      <span className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-accent">
        {brandName}
        {phone && openReviews > 0 && (
          <span
            className="h-2 w-2 rounded-full bg-accent"
            aria-label={`${openReviews} unread review${openReviews === 1 ? "" : "s"}`}
          />
        )}
      </span>
      {/* A link again: /founders/marketing/asset/[id] now EXISTS. It was
          specified, linked, and never built, so every title in this grid was a
          404 — the link was removed to stop it lying. The page imports
          mediaFrame() from this file rather than restating it, which was the
          condition attached to restoring this. */}
      {/* Clamped to two lines; the title attribute carries the whole of it. */}
      <Link
        href={assetHref(id, returnTo)}
        title={title}
        className="text-sm font-medium text-fg line-clamp-2 hover:text-accent transition-colors"
      >
        {title}
      </Link>
      {/* On the phone the hook is already the caption on screen. */}
      {hook && !phone && (
        <p title={hook} className="text-xs text-fg-muted line-clamp-2 italic">
          {hook}
        </p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] uppercase tracking-[0.12em] text-fg-dim font-bold">
          {/* The real distribution when we have it, the primary channel when we
              do not. Showing `channel` alone is what made every tile read
              INSTAGRAM regardless of where the piece actually went. */}
          {platforms.length > 0
            ? platforms.map(platformLabel).join(" · ")
            : channelLabel(channel)}
        </span>
        <StatusTag status={status} publishedAt={publishedAt} />
      </div>
      {phone && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] tabular-nums text-fg-dim">
            {[aspect, duration].filter(Boolean).join(" · ")}
          </span>
          <EnlargeButton title={title} />
        </div>
      )}
      {/* The verdict lives on the tile. Sending the operator somewhere else to approve
          something they are already looking at is how 39 assets ended up sitting in
          review with no way to clear them. */}
      <AssetActions id={id} status={status} title={title} />
    </div>
  );

  if (phone) {
    return (
      <article className="group flex flex-col rounded-xl border border-bg-border bg-bg-panel p-3 shadow-card transition-all hover:border-accent/40">
        <PhoneEnlarge title={title} frame={frameShape} media={bigMedia} className="flex flex-1 flex-col">
          <PhoneFrame {...frameShape} label={title} className="mx-auto max-w-[320px]">
            {media}
          </PhoneFrame>
          {details}
        </PhoneEnlarge>
      </article>
    );
  }

  const { className: frame, style: frameStyle } = mediaFrame(mediaW, mediaH, aspect);
  return (
    <article className="rounded-xl border border-bg-border bg-bg-panel shadow-card overflow-hidden transition-all hover:border-accent/40 hover:shadow-raised group">
      <PhoneEnlarge title={title} frame={frameShape} media={bigMedia}>
        <div
          className={`relative ${frame} bg-bg-deep flex items-center justify-center overflow-hidden`}
          style={frameStyle}
        >
          {media}
          {aspect && (
            <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tracking-wider text-fg-muted">
              {aspect}
            </span>
          )}
          {duration && (
            <span className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tabular-nums text-fg-muted">
              {duration}
            </span>
          )}
          {openReviews > 0 && (
            <span
              className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent shadow-glow"
              aria-label={`${openReviews} unread review${openReviews === 1 ? "" : "s"}`}
            />
          )}
          <EnlargeButton title={title} corner />
        </div>
        {details}
      </PhoneEnlarge>
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
