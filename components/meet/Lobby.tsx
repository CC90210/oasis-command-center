"use client";

/**
 * components/meet/Lobby.tsx - the quiet screens between Join now and the call: "Joining..." while the room
 * answers and the line comes up (the first join, or a dropped line being brought back), and "Waiting for the host
 * to start the meeting." for a guest who is early. A person who joined with a camera keeps seeing it. Leave is
 * offered on every one of them, the join still in flight included: the engine ends the call at once and keeps it
 * ended whatever the join's answer (lib/meet/room-client.ts leave). Which screen offers it is MeetRoom's choice:
 * this one draws the button whenever it is given a way to leave. The same goes for the time: a guest who is early for
 * a meeting made for a time is told when it starts, under the waiting line, if MeetRoom hands the line over.
 */

import { MEET_BRAND, WAITING_FOR_HOST } from "./meet-words";
import { TrackVideo } from "./TrackVideo";

export type LobbyMode = "joining" | "connecting" | "waiting";

export function Lobby({
  mode,
  title,
  preview,
  startsLine,
  onLeave,
}: {
  mode: LobbyMode;
  title: string;
  /** The person's own camera, if they joined with it on. */
  preview: MediaStreamTrack | null;
  /** When the meeting is for ("Your call starts at 2:00 PM."), said under the waiting line; MeetRoom hands it only to the waiting lobby. */
  startsLine?: string | null;
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
        {startsLine ? <p className="mt-1 text-sm text-fg-muted">{startsLine}</p> : null}
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
