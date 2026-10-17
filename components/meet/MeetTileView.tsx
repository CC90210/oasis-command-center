"use client";

/**
 * components/meet/MeetTileView.tsx - one person on the call: their camera, or their initials when it is off.
 *
 * The camera counts as off when the track is missing OR muted: a remote camera that stopped sending reads as a
 * muted track in this browser (lib/meet/room-client.ts), and a frozen last frame would look like a live one.
 * The person's own tile is mirrored. Fills its width at 16:9; the parent decides how many fit in a row.
 */

import { MicOff } from "lucide-react";
import type { MeetTile } from "@/lib/meet/room-client";
import { initialsOf } from "./meet-format";
import { TrackVideo } from "./TrackVideo";

export function MeetTileView({ tile, compact = false }: { tile: MeetTile; compact?: boolean }) {
  const showVideo = !!tile.video && tile.camOn;
  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded-lg border border-hairline bg-bg-panel"
      data-tile={tile.me ? "me" : "other"}
    >
      {showVideo ? (
        <TrackVideo track={tile.video} mirrored={tile.me} />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <span
            aria-hidden
            className={`grid place-items-center rounded-full bg-bg-elev font-semibold text-fg ${
              compact ? "h-8 w-8 text-xs" : "h-12 w-12 text-base sm:h-16 sm:w-16 sm:text-xl"
            }`}
          >
            {initialsOf(tile.name)}
          </span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/70 px-2 py-1 text-[11px] leading-4 text-white sm:text-xs">
        {tile.role === "host" ? (
          <span className="shrink-0 rounded bg-white/20 px-1.5 text-[10px] font-semibold leading-4">Host</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate" title={tile.name}>
          {tile.me ? `${tile.name} (You)` : tile.name}
        </span>
        {!tile.micOn ? (
          <>
            <MicOff className="h-3.5 w-3.5 shrink-0 text-status-hot" aria-hidden />
            <span className="sr-only">Mic off</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
