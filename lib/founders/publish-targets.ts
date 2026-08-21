/**
 * Which connected channel can take which asset — the pure half of AssetPublishPanel.
 *
 * WHY THIS IS ITS OWN MODULE (2026-08-21)
 *   The panel used to gate on `hasVideo: boolean`, derived from the video url alone.
 *   A carousel has no video and never will, so the flag arrived false and the panel
 *   told CC "every channel below will refuse this asset" — about the exact format the
 *   whole feed pivoted to that day. The backend was never the blocker:
 *   marketing_publish_drain.fetch_media returns the cover plus the ordered slides for
 *   asset_type "carousel" and publishes them correctly.
 *
 *   Fixing the message alone would have swapped one wrong answer for another, because
 *   TikTok and YouTube genuinely cannot take an image deck and X truncates past four.
 *   So the rule is per-channel, and it lives here — outside the client component — so
 *   it can be tested without a DOM.
 *
 * NOT THE SAME "CHANNELS" AS lib/founders-marketing-core.ts. That one is the content
 * taxonomy an asset is CLASSIFIED by ("organic-instagram", "paid-meta", "seo-article");
 * this one is the set of connected accounts an asset can be PUBLISHED TO. They overlap
 * in vocabulary and in nothing else — do not try to merge them.
 */

/**
 * `imageCap` is how many images the channel accepts in ONE post; 0 means the surface
 * is video-only.
 *
 * These mirror PLATFORM_IMAGE_CAP in CMO-Agent/scripts/schedule_posts.py, which
 * enforces the same limits on the SCHEDULED path. Two copies of one rule is a drift
 * risk accepted only because the two live in different languages and repos — change
 * one, change the other.
 */
export const PUBLISH_CHANNELS = [
  { id: "instagram", label: "Instagram", handle: "@oasisaisolutions", imageCap: 10 },
  { id: "tiktok", label: "TikTok", handle: "@ccmckennaa", imageCap: 0 },
  { id: "youtube", label: "YouTube", handle: "@ccmusicc03", imageCap: 0 },
  { id: "twitter", label: "X", handle: "@Conaugh90210", imageCap: 4 },
  { id: "threads", label: "Threads", handle: "@ccmckennaa", imageCap: 10 },
  { id: "linkedin", label: "LinkedIn", handle: "Conaugh McKenna", imageCap: 20 },
] as const;

export type PublishChannel = (typeof PUBLISH_CHANNELS)[number];

/** What is actually attached to the asset — NOT "is there a video". */
export type PublishMediaKind = "video" | "images" | "none";

/**
 * Why a channel cannot take THIS asset, or null when it can. Returns the reason
 * rather than a boolean so the tooltip can name the limit that bit.
 */
export function refusalFor(
  channel: PublishChannel,
  mediaKind: PublishMediaKind,
  slideCount: number,
): string | null {
  if (mediaKind === "none") return "No media is attached to this asset";
  if (mediaKind === "video") return null; // every connected surface takes video
  if (channel.imageCap === 0) return `${channel.label} only accepts video`;
  if (slideCount > channel.imageCap) {
    return `${channel.label} accepts ${channel.imageCap} images per post; this deck has ${slideCount}`;
  }
  return null;
}

/** Channels that cannot take this asset, in CHANNELS order. */
export function unavailableChannels(
  mediaKind: PublishMediaKind,
  slideCount: number,
): PublishChannel[] {
  return PUBLISH_CHANNELS.filter((c) => refusalFor(c, mediaKind, slideCount) !== null);
}

/** "TikTok, YouTube and X" — not "TikTok and YouTube and X". */
export function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
