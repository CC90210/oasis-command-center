"use client";

/**
 * components/meet/CallScreen.tsx - the call itself: a title bar with the Recording indicator, the faces (or a
 * shared screen with the faces as a strip), the people list, and the controls bar.
 *
 * A dark stage, like Meet. It draws whatever the snapshot says (lib/meet/room-client.ts), so the same screen
 * runs from the real controller and from a stand-in in tests. Other people's voices play through hidden
 * <audio> elements, one per remote microphone; every <video> is muted.
 *
 * RECORDING: the indicator is a red dot WITH the word, shown to everyone while the recording is running (not by
 * colour alone, and not only to the host). "Running" is the room's own answer, snapshot.roomRecording: the room
 * records AND the one browser recording it (any host's) is in the call. A recorded room whose hosts' browsers are
 * not recording yet shows nothing: the badge is never claimed from `recordAudio` or a host being present.
 */

import { useCallback, useEffect, useState } from "react";
import { reportClientError } from "@/lib/client-errors/report";
import type { MeetRoomController, MeetSnapshot } from "@/lib/meet/room-client";
import { CallControls } from "./CallControls";
import { FOCUS } from "./meet-classes";
import { gridClasses, gridFit, sharerOf } from "./meet-format";
import { MeetTileView } from "./MeetTileView";
import { PeoplePanel } from "./PeoplePanel";
import { RemoteAudio, TrackVideo } from "./TrackVideo";

/** How long a "that did not work" line stays up. */
const PROBLEM_MS = 6_000;

export function CallScreen({
  controller,
  snapshot,
  code,
  title,
  canShare,
}: {
  controller: MeetRoomController;
  snapshot: MeetSnapshot;
  /** The dashed code. */
  code: string;
  /** What the page was told; the room's own answer replaces it once the first state arrives. */
  title: string;
  canShare: boolean;
}) {
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [soundRetry, setSoundRetry] = useState(0);

  useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => setProblem(null), PROBLEM_MS);
    return () => clearTimeout(timer);
  }, [problem]);

  const onSoundBlocked = useCallback(() => setSoundBlocked(true), []);

  // A call on the controller that throws is reported and said in plain words; the call goes on.
  const attempt = useCallback(async (task: Promise<unknown>) => {
    try {
      await task;
    } catch (err) {
      reportClientError("rejection", err);
      setProblem("That did not work. Try again.");
    }
  }, []);

  const tiles = snapshot.tiles;
  const sharer = sharerOf(tiles);
  const isHost = snapshot.me?.role === "host";
  const recording = snapshot.roomRecording;
  const line = problem ?? snapshot.notice;
  const heading = snapshot.room?.title ?? title;

  const faces = sharer ? (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 sm:p-3 lg:flex-row">
      <section
        aria-label="Shared screen"
        className="relative min-h-[13rem] min-w-0 flex-1 overflow-hidden rounded-lg border border-hairline bg-black"
      >
        {sharer.me ? (
          <div className="absolute inset-0 grid place-items-center p-4">
            <div className="max-w-xs text-center">
              <p className="text-sm text-fg">You are sharing your screen.</p>
              <button
                type="button"
                onClick={() => void attempt(controller.shareScreen(false))}
                className={`mt-3 min-h-11 rounded-lg border border-hairline bg-bg-raised px-4 text-sm font-medium text-fg hover:bg-bg-elev ${FOCUS}`}
              >
                Stop sharing
              </button>
            </div>
          </div>
        ) : (
          <>
            <TrackVideo track={sharer.screen} fit="contain" label={`${sharer.name} is sharing their screen`} />
            <p className="absolute left-2 top-2 max-w-[calc(100%-1rem)] break-words rounded bg-black/70 px-2 py-1 text-xs text-white">
              {sharer.name} is sharing their screen
            </p>
          </>
        )}
      </section>
      <ul className="grid shrink-0 grid-cols-3 gap-2 sm:grid-cols-4 lg:w-48 lg:grid-cols-1 lg:content-start lg:overflow-y-auto">
        {tiles.map((t) => (
          <li key={t.participantId} className="min-w-0">
            <MeetTileView tile={t} compact />
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2 sm:p-3">
      <ul
        className={["mx-auto my-auto grid w-full gap-2", tiles.length <= 1 ? "max-w-3xl" : "", gridClasses(tiles.length), gridFit(tiles.length)]
          .filter(Boolean)
          .join(" ")}
      >
        {tiles.map((t) => (
          <li key={t.participantId} className="min-w-0">
            <MeetTileView tile={t} />
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="flex h-screen h-dvh min-h-0 flex-col bg-bg-rail text-fg">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-hairline px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] leading-4 text-fg-dim">Oasis Meet</p>
          <h1 className="break-words text-sm font-semibold leading-5 text-fg">{heading}</h1>
        </div>
        {recording ? (
          <p
            className="inline-flex items-center gap-1.5 rounded-full border border-status-hot/40 px-2.5 py-1 text-xs font-medium text-fg"
            title="This meeting is being recorded and transcribed."
          >
            <span aria-hidden className="h-2 w-2 rounded-full bg-status-hot" />
            Recording
          </p>
        ) : null}
      </header>
      {line ? (
        <p role="status" className="border-b border-hairline px-3 py-1.5 text-xs text-fg-muted">
          {line}
        </p>
      ) : null}
      {soundBlocked ? (
        <div className="border-b border-hairline px-3 py-2">
          <button
            type="button"
            onClick={() => {
              setSoundBlocked(false);
              setSoundRetry((n) => n + 1);
            }}
            className={`min-h-11 rounded-lg border border-hairline bg-bg-raised px-4 text-sm font-medium text-fg hover:bg-bg-elev ${FOCUS}`}
          >
            Tap to turn on sound
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className={`min-h-0 min-w-0 flex-1 flex-col ${peopleOpen ? "hidden lg:flex" : "flex"}`}>{faces}</div>
        {peopleOpen ? (
          <PeoplePanel
            tiles={tiles}
            isHost={isHost}
            onRemove={(id) => controller.remove(id)}
            onClose={() => setPeopleOpen(false)}
          />
        ) : null}
      </div>
      {tiles.map((t) =>
        !t.me && t.audio ? <RemoteAudio key={t.participantId} track={t.audio} retry={soundRetry} onBlocked={onSoundBlocked} /> : null,
      )}
      <CallControls
        controller={controller}
        snapshot={snapshot}
        code={code}
        isHost={isHost}
        canShare={canShare}
        peopleOpen={peopleOpen}
        onTogglePeople={() => setPeopleOpen((open) => !open)}
        attempt={attempt}
      />
    </div>
  );
}
