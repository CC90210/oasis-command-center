"use client";

/**
 * components/meet/useJoinDevices.ts - the camera and microphone a person sets up on the pre-join screen.
 *
 * `allowed` is the recording-notice gate (components/meet/notice.ts mayAskForDevices). While it is false nothing
 * here touches the browser, and if it goes false again (the person un-ticks the notice) whatever is held is
 * stopped on the spot, so a withdrawn agreement never leaves a camera running.
 *
 * Off means released: a camera or microphone that is turned off is stopped (its light goes out) and asked for
 * again when turned back on. Joining hands the room COPIES of the held tracks (takeForJoin), so a join that
 * fails leaves the preview running for another try; release() stops the originals once a join has worked.
 *
 * An answer from the browser can arrive late: after a newer request for the same device, after release, after
 * consent was withdrawn, after the person stopped waiting, after the screen is gone. devices.ts createDeviceRequests
 * numbers every request and stops the tracks of an answer that is no longer wanted, so a late camera never stays on.
 * A join does not cancel: if it fails the person is still here and keeps what the request brings; if it works
 * release() follows and stops it.
 *
 * A browser may never answer (the person ignores its prompt). `asking` then stays true, which keeps Join now off so
 * nobody joins by mistake without the camera they just allowed; stopWaiting() is the person's way out of it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { reportClientError } from "@/lib/client-errors/report";
import { NOT_WAITING, createDeviceRequests, deviceWords, listInputs, openDevices, type DeviceChoice, type PolicyLike, type Waiting } from "./devices";

export type JoinDevices = {
  /** The person has taken the camera and microphone step (even if nothing came back). */
  asked: boolean;
  /** A request for the camera or microphone is still waiting on the browser. */
  asking: boolean;
  /** Which devices that is (so the way out can name them); nothing when `asking` is false. */
  waiting: Waiting;
  mic: MediaStreamTrack | null;
  cam: MediaStreamTrack | null;
  /** Plain words for what did not come back, else null. */
  words: string | null;
  mics: DeviceChoice[];
  cams: DeviceChoice[];
  micId: string;
  camId: string;
  turnOn: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  pickMic: (id: string) => void;
  pickCam: (id: string) => void;
  takeForJoin: () => { mic: MediaStreamTrack | null; cam: MediaStreamTrack | null };
  /**
   * The person would rather join than keep waiting: whatever is still open is let go (its answer is stopped when it
   * comes) and `asking` comes down at once. What is already held stays, for the join to take.
   */
  stopWaiting: () => void;
  release: () => void;
};

type Kind = "mic" | "cam";

function currentMedia(): MediaDevices | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
}

/** The page's permissions policy, to tell a site that forbids the camera from a person who said no. */
function currentPolicy(): PolicyLike | null {
  if (typeof document === "undefined") return null;
  const d = document as Document & { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike };
  return d.permissionsPolicy ?? d.featurePolicy ?? null;
}

export function useJoinDevices(allowed: boolean): JoinDevices {
  const [mic, setMic] = useState<MediaStreamTrack | null>(null);
  const [cam, setCam] = useState<MediaStreamTrack | null>(null);
  const [asked, setAsked] = useState(false);
  const [waiting, setWaiting] = useState<Waiting>(NOT_WAITING);
  const asking = waiting.mic || waiting.cam;
  const [words, setWords] = useState<string | null>(null);
  const [inputs, setInputs] = useState<{ mics: DeviceChoice[]; cams: DeviceChoice[] }>({ mics: [], cams: [] });
  const [micId, setMicId] = useState("");
  const [camId, setCamId] = useState("");
  // Which request for the devices still counts (devices.ts): one for the life of the screen.
  const [requests] = useState(createDeviceRequests);
  // What an async handler must see after an await, where state would be stale. One object, changed in place.
  const live = useRef<{ mic: MediaStreamTrack | null; cam: MediaStreamTrack | null; allowed: boolean; micId: string; camId: string }>({
    mic: null,
    cam: null,
    allowed,
    micId: "",
    camId: "",
  });

  useEffect(() => {
    live.current.allowed = allowed;
  }, [allowed]);

  const hold = useCallback((kind: Kind, track: MediaStreamTrack | null) => {
    const before = live.current[kind];
    if (before && before !== track) before.stop();
    live.current[kind] = track;
    (kind === "mic" ? setMic : setCam)(track);
  }, []);

  const refreshInputs = useCallback(async () => {
    setInputs(await listInputs(currentMedia()));
  }, []);

  const ask = useCallback(
    async (want: { mic: boolean; cam: boolean }) => {
      // One request, start to finish (devices.ts run): what comes back is kept only if it is still wanted, not asked
      // for again, not cancelled (released, left, consent withdrawn, stopped waiting), the notice still ticked; the
      // rest is stopped there. A request that throws still settles, so a throw cannot leave `asking` up; one the
      // browser never answers (the person ignores its prompt) is still open, and `asking` rightly says so until
      // the person stops waiting.
      const answered = requests.run(
        want,
        () =>
          openDevices({
            allowed: live.current.allowed,
            media: currentMedia(),
            want,
            micId: live.current.micId,
            camId: live.current.camId,
            policy: currentPolicy(),
          }),
        () => live.current.allowed,
        (err) => reportClientError("rejection", err),
      );
      // run has counted its request on the way in: say what is waited for now, not when the first one settles.
      setWaiting(requests.waiting());
      const answer = await answered;
      setWaiting(answer.waiting);
      if (!answer.current) return;
      if (answer.mic) hold("mic", answer.mic);
      if (answer.cam) hold("cam", answer.cam);
      setAsked(true);
      setWords(deviceWords(answer.problems));
      if (answer.mic || answer.cam) await refreshInputs();
    },
    [hold, refreshInputs, requests],
  );

  // Whatever is still open is let go: nobody waits on it any more, and its answer is stopped when it comes. What is
  // held is not touched here.
  const abandon = useCallback(() => {
    requests.cancel();
    setWaiting(NOT_WAITING);
  }, [requests]);

  // Consent withdrawn: let go of everything and go back to the step before the camera.
  useEffect(() => {
    if (allowed) return;
    abandon();
    hold("mic", null);
    hold("cam", null);
    setAsked(false);
    setWords(null);
    setInputs({ mics: [], cams: [] });
  }, [allowed, abandon, hold]);

  // Leaving the screen for any other reason: the camera must not outlive it. (The room's copies are not touched.)
  // A request still open when it goes is cancelled, so its answer is stopped when it arrives.
  useEffect(() => {
    const store = live.current;
    return () => {
      requests.cancel();
      store.mic?.stop();
      store.cam?.stop();
    };
  }, [requests]);

  useEffect(() => {
    const media = currentMedia();
    if (!asked || !media || typeof media.addEventListener !== "function") return;
    const onChange = () => void refreshInputs();
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [asked, refreshInputs]);

  const release = useCallback(() => {
    abandon();
    hold("mic", null);
    hold("cam", null);
  }, [abandon, hold]);

  const toggle = useCallback(
    (kind: Kind) => {
      if (live.current[kind]) {
        hold(kind, null);
        return;
      }
      void ask({ mic: kind === "mic", cam: kind === "cam" });
    },
    [ask, hold],
  );

  const pick = useCallback(
    (kind: Kind, id: string) => {
      live.current[kind === "mic" ? "micId" : "camId"] = id;
      (kind === "mic" ? setMicId : setCamId)(id);
      // Switching while the device is on: ask for the chosen one (the old track stops when the new one arrives).
      if (live.current[kind]) void ask({ mic: kind === "mic", cam: kind === "cam" });
    },
    [ask],
  );

  return {
    asked,
    asking,
    waiting,
    mic,
    cam,
    words,
    mics: inputs.mics,
    cams: inputs.cams,
    micId,
    camId,
    turnOn: () => void ask({ mic: true, cam: true }),
    toggleMic: () => toggle("mic"),
    toggleCam: () => toggle("cam"),
    pickMic: (id) => pick("mic", id),
    pickCam: (id) => pick("cam", id),
    // The room takes copies; nothing is cancelled. A join that fails leaves the person on this screen, which is where
    // a request still open belongs, so what it brings is kept. A join that works is followed by release(), which
    // cancels, and a screen that goes away cancels too.
    takeForJoin: () => ({ mic: live.current.mic?.clone() ?? null, cam: live.current.cam?.clone() ?? null }),
    stopWaiting: abandon,
    release,
  };
}
