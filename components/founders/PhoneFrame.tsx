/**
 * PhoneFrame - an asset the way it lands on a phone.
 *
 * CC asked for this three times: "iPhone-frame preview like Instagram/TikTok"
 * (round 1), "iPhone display for all content including chat-made" (round 3),
 * and on 2026-10-01 that the Library was "not in the preferred iPhone view".
 * Until now a reel rendered as a desktop video player inside a card, so there
 * was no way to see how the caption, the action column and the crop would sit
 * on a real screen.
 *
 * CSS ONLY, NO IMAGES. The bezel, the dynamic island, the status bar, the side
 * buttons and the home indicator are boxes; the overlay icons are the app's own
 * icon set. Nothing here is a picture of a phone, so it scales cleanly, follows
 * no vendor artwork, and costs no request.
 *
 * GEOMETRY. The screen is an iPhone's 9:19.5. Inside it, the reel area is 9:16
 * at full width (where Reels and TikTok play a vertical video), between the
 * status bar and the tab bar - their device safe areas. The asset sits in the
 * reel area at its REAL shape (phoneMediaFit in lib/founders-marketing-core.ts):
 * 9:16 fills it; 4:5, 1:1 and 16:9 are letterboxed, never cropped. Every size
 * inside is in container units of the frame's own width, so a 200px Library
 * tile and a 380px detail view are the same drawing at two scales.
 *
 * The overlay never invents a fact: the account line is the asset's brand
 * name as stored, the caption is its own hook, and the action column carries
 * no counts, because there are none to show for an unposted asset.
 *
 * Server-renderable (no hooks). The media is `children`, laid out by the
 * caller to fill the box this frame computes (`h-full w-full object-contain`).
 */
import type { ReactNode } from "react";
import {
  Bookmark,
  Camera,
  Clapperboard,
  Heart,
  Home,
  Inbox,
  MessageCircle,
  MoreHorizontal,
  Plus,
  PlusSquare,
  Search,
  Send,
  Share2,
  User,
  Users,
} from "lucide-react";

import { phoneMediaFit, type PhoneChrome } from "@/lib/founders-marketing-core";

// Shares of the 9:19.5 screen's HEIGHT. iPhone 15: status bar 59 of 852 pt;
// the reel area is 9:16 at full width; the tab bar and home indicator take
// what is left at the bottom.
const STATUS_PCT = (1.4 / 19.5) * 100;
const REEL_PCT = (16 / 19.5) * 100;
const TABS_PCT = 100 - STATUS_PCT - REEL_PCT;

const ICON = "h-[6.4cqw] w-[6.4cqw] text-white [filter:drop-shadow(0_1px_1px_rgba(0,0,0,0.6))]";

export function PhoneFrame({
  mediaW,
  mediaH,
  aspect,
  handle,
  caption,
  chrome = "instagram",
  guides = false,
  label,
  children,
  className = "",
}: {
  mediaW?: number | null;
  mediaH?: number | null;
  aspect?: string | null;
  /** The account line. The asset's brand name as stored - never a made-up handle. */
  handle: string;
  /** The asset's own copy (its hook). Clamped to two lines, as the apps do. */
  caption?: string | null;
  chrome?: PhoneChrome;
  /** Outline the parts of the reel the app's own UI covers. */
  guides?: boolean;
  /** What the frame shows, for assistive tech. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const fit = phoneMediaFit(mediaW, mediaH, aspect);
  const name = handle.trim() || "Account";
  const initial = name[0]!.toUpperCase();
  const tiktok = chrome === "tiktok";

  return (
    <figure
      data-phone-frame=""
      data-fit={fit.mode}
      data-chrome={chrome}
      aria-label={`${label}, as it shows on a phone`}
      className={`m-0 w-full [container-type:inline-size] ${className}`}
    >
      {/* Bezel. The side buttons are the only thing outside the screen. */}
      <div className="relative rounded-[13cqw] bg-neutral-900 p-[2.6cqw] shadow-[0_8px_24px_rgba(0,0,0,0.45)] ring-1 ring-white/10">
        <span aria-hidden className="absolute -left-[0.7cqw] top-[17%] h-[5%] w-[0.7cqw] rounded-l-sm bg-neutral-700" />
        <span aria-hidden className="absolute -left-[0.7cqw] top-[25%] h-[9%] w-[0.7cqw] rounded-l-sm bg-neutral-700" />
        <span aria-hidden className="absolute -right-[0.7cqw] top-[22%] h-[13%] w-[0.7cqw] rounded-r-sm bg-neutral-700" />

        {/* Screen, 9:19.5. */}
        <div
          className="relative w-full overflow-hidden rounded-[10.5cqw] bg-black text-white"
          style={{ aspectRatio: "9 / 19.5" }}
        >
          {/* Status bar: a device safe area, never covered by content. */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 flex items-center justify-between px-[7.5cqw] text-[3.4cqw] font-semibold"
            style={{ height: `${STATUS_PCT}%` }}
          >
            <span className="tabular-nums">9:41</span>
            <span className="absolute left-1/2 top-[18%] h-[58%] w-[29cqw] -translate-x-1/2 rounded-full bg-black ring-1 ring-white/10" />
            <span className="flex items-end gap-[0.6cqw]">
              <span className="h-[1.2cqw] w-[0.8cqw] rounded-[0.2cqw] bg-white" />
              <span className="h-[1.8cqw] w-[0.8cqw] rounded-[0.2cqw] bg-white" />
              <span className="h-[2.4cqw] w-[0.8cqw] rounded-[0.2cqw] bg-white" />
              <span className="ml-[1cqw] h-[2.6cqw] w-[5.4cqw] rounded-[0.8cqw] border-[0.35cqw] border-white/80 p-[0.35cqw]">
                <span className="block h-full w-3/4 rounded-[0.3cqw] bg-white" />
              </span>
            </span>
          </div>

          {/* Reel area, 9:16. */}
          <div
            data-reel-area=""
            className="absolute inset-x-0 overflow-hidden bg-black"
            style={{ top: `${STATUS_PCT}%`, height: `${REEL_PCT}%` }}
          >
            <div
              data-media-box=""
              className="absolute"
              style={{
                left: `${(100 - fit.widthPct) / 2}%`,
                top: `${(100 - fit.heightPct) / 2}%`,
                width: `${fit.widthPct}%`,
                height: `${fit.heightPct}%`,
              }}
            >
              {children}
            </div>

            {/* The app's chrome. pointer-events-none so the media's own
                controls (play, carousel arrows) stay reachable underneath. */}
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute inset-x-0 top-0 flex items-center justify-between px-[4cqw] pt-[3cqw] text-[4.2cqw] font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
                {tiktok ? (
                  <>
                    <span className="w-[6.4cqw]" />
                    <span className="flex gap-[4cqw] text-[3.6cqw]">
                      <span className="text-white/70">Following</span>
                      <span className="border-b-[0.5cqw] border-white pb-[0.6cqw]">For You</span>
                    </span>
                    <Search className={ICON} />
                  </>
                ) : (
                  <>
                    <span>Reels</span>
                    <Camera className={ICON} />
                  </>
                )}
              </div>

              <div className="absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-t from-black/70 to-transparent" />

              <div className="absolute bottom-[6%] right-[2.6cqw] flex flex-col items-center gap-[4.6cqw]">
                {tiktok && (
                  <span className="mb-[1cqw] flex h-[9cqw] w-[9cqw] items-center justify-center rounded-full border-[0.4cqw] border-white bg-neutral-700 text-[3.8cqw] font-bold">
                    {initial}
                  </span>
                )}
                <Heart className={ICON} />
                <MessageCircle className={ICON} />
                {tiktok ? <Bookmark className={ICON} /> : <Send className={ICON} />}
                {tiktok ? <Share2 className={ICON} /> : <MoreHorizontal className={ICON} />}
                <span
                  className={
                    tiktok
                      ? "mt-[1cqw] h-[8cqw] w-[8cqw] rounded-full border-[1.6cqw] border-neutral-800 bg-neutral-600"
                      : "mt-[1cqw] h-[6.4cqw] w-[6.4cqw] rounded-[1.4cqw] border-[0.4cqw] border-white bg-neutral-700"
                  }
                />
              </div>

              <div className="absolute bottom-[5%] left-[3.6cqw] right-[15cqw] flex flex-col gap-[1.6cqw] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
                <div className="flex min-w-0 items-center gap-[2cqw] text-[3.6cqw] font-semibold">
                  {!tiktok && (
                    <span className="flex h-[7cqw] w-[7cqw] shrink-0 items-center justify-center rounded-full bg-neutral-700 text-[3.2cqw] font-bold">
                      {initial}
                    </span>
                  )}
                  {/* The brand name, never an "@handle": the asset row has no handle
                      and a made-up one would be a fact we do not hold. */}
                  <span className="truncate">{name}</span>
                  {!tiktok && (
                    <span className="shrink-0 rounded-[1.4cqw] border-[0.3cqw] border-white/80 px-[1.8cqw] py-[0.4cqw] text-[3cqw]">
                      Follow
                    </span>
                  )}
                </div>
                {caption ? (
                  <p className="m-0 line-clamp-2 text-[3.3cqw] leading-[1.35] text-white/95">{caption}</p>
                ) : null}
              </div>

              {guides && (
                <>
                  <div className="absolute inset-x-0 top-0 h-[11%] border-b-[0.4cqw] border-dashed border-amber-300/80 bg-amber-300/10" />
                  <div className="absolute inset-x-0 bottom-0 h-[24%] border-t-[0.4cqw] border-dashed border-amber-300/80 bg-amber-300/10" />
                  <div className="absolute bottom-[24%] right-0 top-[11%] w-[17%] border-l-[0.4cqw] border-dashed border-amber-300/80 bg-amber-300/10" />
                </>
              )}
            </div>
          </div>

          {/* Tab bar + home indicator: the bottom safe area. */}
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 flex flex-col justify-between border-t border-white/10 bg-black px-[6cqw] pt-[2.4cqw]"
            style={{ height: `${TABS_PCT}%` }}
          >
            <div className="flex items-center justify-between text-white/85">
              <Home className="h-[5.6cqw] w-[5.6cqw]" />
              {tiktok ? <Users className="h-[5.6cqw] w-[5.6cqw]" /> : <Search className="h-[5.6cqw] w-[5.6cqw]" />}
              {tiktok ? (
                <span className="flex h-[6cqw] w-[9cqw] items-center justify-center rounded-[1.6cqw] bg-white text-black">
                  <Plus className="h-[4.4cqw] w-[4.4cqw]" />
                </span>
              ) : (
                <PlusSquare className="h-[5.6cqw] w-[5.6cqw]" />
              )}
              {tiktok ? <Inbox className="h-[5.6cqw] w-[5.6cqw]" /> : <Clapperboard className="h-[5.6cqw] w-[5.6cqw] text-white" />}
              <User className="h-[5.6cqw] w-[5.6cqw]" />
            </div>
            <span className="mx-auto mb-[1.8cqw] h-[1.2cqw] w-[34%] rounded-full bg-white/90" />
          </div>
        </div>
      </div>
    </figure>
  );
}

/**
 * The screen content for an asset with no picture: a text post, an HTML page,
 * an audio file, or a video whose render is not on file yet. The phone still
 * shows the copy, so nothing in the Library is a blank tile.
 */
export function PhoneTextCard({
  kicker,
  text,
  note,
}: {
  kicker: string;
  text: string;
  note?: string | null;
}) {
  return (
    <div className="flex h-full w-full flex-col justify-center gap-[3cqw] bg-neutral-900 px-[8cqw] text-left">
      <span className="text-[3cqw] font-semibold text-white/60">{kicker}</span>
      <p className="m-0 line-clamp-6 text-[5.6cqw] font-semibold leading-[1.25] text-white">{text}</p>
      {note ? <span className="text-[3cqw] text-white/50">{note}</span> : null}
    </div>
  );
}
