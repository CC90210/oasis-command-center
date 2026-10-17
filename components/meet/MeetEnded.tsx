"use client";

/**
 * components/meet/MeetEnded.tsx - the screen for a meeting that is over, in plain words by why (ENDED_WORDS):
 * the person left (with Rejoin, which reloads the page), the host ended it, the host removed them, or the room
 * was already closed when the link was opened. A host also gets the way back to the Schedule.
 *
 * The way back is a plain <a>, not a <Link>: /meet is a page without the app shell, and a soft navigation from
 * it into the Schedule would draw the Schedule without its rail (lib/os/full-bleed.ts, tests/shell-boundary.test.ts).
 */

import type { MeetEndReason } from "@/lib/meet/room-client";
import { ENDED_WORDS, MEET_BRAND } from "./meet-words";

export function MeetEnded({ reason, isHost, title }: { reason: MeetEndReason; isHost: boolean; title?: string }) {
  return (
    <main className="flex min-h-screen min-h-dvh items-start justify-center bg-bg px-4 py-10 sm:items-center">
      <section className="w-full max-w-md rounded-xl border border-hairline bg-bg-panel p-6">
        <p className="text-xs text-fg-dim">{MEET_BRAND}</p>
        {title ? <p className="mt-1 break-words text-sm text-fg-muted">{title}</p> : null}
        <h1 className="mt-3 text-xl font-semibold text-fg">{ENDED_WORDS[reason]}</h1>
        {reason === "left" || isHost ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {reason === "left" ? (
              <button type="button" onClick={() => window.location.reload()} className="btn-primary inline-flex min-h-11 items-center justify-center">
                Rejoin
              </button>
            ) : null}
            {isHost ? (
              <a href="/schedule" className="btn-secondary inline-flex min-h-11 items-center justify-center">
                Back to Schedule
              </a>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
