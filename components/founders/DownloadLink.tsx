/**
 * "Download" — saves the asset's original file to this computer.
 *
 * A plain anchor to the download route, not a button with a fetch: the route
 * redirects to an R2 URL signed with `Content-Disposition: attachment`, so the
 * browser saves the file and the page stays where it is. No client state, so it
 * renders on the server and in the tile alike.
 *
 * CC, 2026-10-16: "I want to be able to download the actual videos to my computer
 * ... all the videos in the library section in content."
 */
import { Download } from "lucide-react";

import { assetDownloadHref } from "@/lib/founders/asset-download";

export function DownloadLink({
  assetId,
  title,
  slide,
  corner = false,
  label = "Download",
}: {
  assetId: string;
  title: string;
  /** 1-based slide of a carousel; omitted = the video, or the cover. */
  slide?: number;
  /** The icon-only circle that sits in a grid tile's media corner. */
  corner?: boolean;
  label?: string;
}) {
  return (
    <a
      href={assetDownloadHref(assetId, slide)}
      aria-label={`Download ${slide ? `slide ${slide} of ` : ""}${title}`}
      title="Save the original file to your computer"
      className={
        corner
          ? "absolute bottom-2 left-11 flex h-7 w-7 items-center justify-center rounded-full bg-bg-deep/80 text-fg-muted ring-1 ring-white/10 transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
          : "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-bg-border bg-bg-deep/40 px-2.5 py-1 text-[11px] font-semibold text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
      }
    >
      <Download aria-hidden className="h-3.5 w-3.5" />
      {corner ? null : label}
    </a>
  );
}
