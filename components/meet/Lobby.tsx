"use client";

/**
 * components/meet/Lobby.tsx - the quiet screens between Join now and the call: "Joining..." while the room
 * answers and the line comes up, and "Waiting for the host to start the meeting." for a guest who is early.
 * A person who joined with a camera keeps seeing it. Leave is offered once the room has accepted them (not
 * while the join itself is in flight, which cannot be taken back half way).
 */

import { MEET_BRAND, WAITING_FOR_HOST } from "./meet-words";
import { TrackVideo } from "./TrackVideo";

export type LobbyMode = "joining" | "connecting" | "waiting";

export function Lobby({
  mode,
  title,
  preview,
  onLeave,
}: {
  mode: LobbyMode;
  title: string;
  /** The person's own camera, if they joined with it on. */
  preview: MediaStreamTrack | null;
  onLeave?: () => void;
}) {
  return (
    <main className="min-h-screen min-h-dvh bg-bg px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-lg">
        <p className="text-xs text-fg-dim">{MEET_BRAND}</p>
        <h1 className="mt-1 break-words text-xl font-semibold text-fg sm:text-2xl">{title}</h1>
        <p role="status" className="mt-5 text-base text-fg">
          {mode === "waiting" ? WAITING_FOR_HOST : "Joining..."}
        </p>
        {preview ? (
          <div className="relative mt-4 aspect-video w-full overflow-hidden rounded-lg border border-hairline bg-bg-panel">
            <TrackVideo track={preview} mirrored label="Your camera" />
          </div>
        ) : null}
        {onLeave ? (
          <button type="button" onClick={onLeave} className="btn-secondary mt-5 inline-flex min-h-11 w-full items-center justify-center sm:w-auto">
            Leave
          </button>
        ) : null}
      </div>
    </main>
  );
}
