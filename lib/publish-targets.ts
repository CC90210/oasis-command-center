/**
 * Shared publishing capability contract for the founders studio and OASIS
 * publisher. Both surfaces need one source of truth for channel identities and
 * image limits, so this module is infrastructure rather than portal-owned code.
 *
 * These are publishing destinations, not the content-taxonomy channels in
 * lib/founders-marketing-core.ts.
 */

/**
 * `imageCap` is how many images the channel accepts in one post; 0 means the
 * surface is video-only.
 *
 * These mirror PLATFORM_IMAGE_CAP in CMO-Agent/scripts/schedule_posts.py,
 * which enforces the same limits on the scheduled path.
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

/** What is actually attached to the asset, not merely whether it has video. */
export type PublishMediaKind = "video" | "images" | "none";

/**
 * Read a string array from either a native array or Turso TEXT holding JSON.
 * Malformed values degrade to an empty list, matching the established founders
 * reader behavior.
 */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Ordered slide storage paths; duplicates and stored order are significant. */
export const parseSlideUrls = parseStringArray;

/** Why a channel cannot take this asset, or null when it can. */
export function refusalFor(
  channel: PublishChannel,
  mediaKind: PublishMediaKind,
  slideCount: number,
): string | null {
  if (mediaKind === "none") return "No media is attached to this asset";
  if (mediaKind === "video") return null;
  if (channel.imageCap === 0) return `${channel.label} only accepts video`;
  if (slideCount > channel.imageCap) {
    return `${channel.label} accepts ${channel.imageCap} images per post; this deck has ${slideCount}`;
  }
  return null;
}

/** Channels that cannot take this asset, in channel order. */
export function unavailableChannels(
  mediaKind: PublishMediaKind,
  slideCount: number,
): PublishChannel[] {
  return PUBLISH_CHANNELS.filter((channel) => refusalFor(channel, mediaKind, slideCount) !== null);
}

/** Format a human-readable list with a final "and". */
export function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
