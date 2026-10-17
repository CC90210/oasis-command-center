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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { deviceWords, listInputs, openDevices, type DeviceChoice, type PolicyLike } from "./devices";

export type JoinDevices = {
  /** The person has taken the camera and microphone step (even if nothing came back). */
  asked: boolean;
  asking: boolean;
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
  const [asking, setAsking] = useState(false);
  const [words, setWords] = useState<string | null>(null);
  const [inputs, setInputs] = useState<{ mics: DeviceChoice[]; cams: DeviceChoice[] }>({ mics: [], cams: [] });
  const [micId, setMicId] = useState("");
  const [camId, setCamId] = useState("");
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
      setAsking(true);
      const opened = await openDevices({
        allowed: live.current.allowed,
        media: currentMedia(),
        want,
        micId: live.current.micId,
        camId: live.current.camId,
        policy: currentPolicy(),
      });
      setAsking(false);
      if (!live.current.allowed) {
        // The notice was un-ticked while the browser's own prompt was open: take nothing.
        opened.mic?.stop();
        opened.cam?.stop();
        return;
      }
      if (opened.mic) hold("mic", opened.mic);
      if (opened.cam) hold("cam", opened.cam);
      setAsked(true);
      setWords(deviceWords(opened.problems));
      if (opened.mic || opened.cam) await refreshInputs();
    },
    [hold, refreshInputs],
  );

  // Consent withdrawn: let go of everything and go back to the step before the camera.
  useEffect(() => {
    if (allowed) return;
    hold("mic", null);
    hold("cam", null);
    setAsked(false);
    setWords(null);
    setInputs({ mics: [], cams: [] });
  }, [allowed, hold]);

  // Leaving the screen for any other reason: the camera must not outlive it. (The room's copies are not touched.)
  useEffect(() => {
    const store = live.current;
    return () => {
      store.mic?.stop();
      store.cam?.stop();
    };
  }, []);

  useEffect(() => {
    const media = currentMedia();
    if (!asked || !media || typeof media.addEventListener !== "function") return;
    const onChange = () => void refreshInputs();
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [asked, refreshInputs]);

  const release = useCallback(() => {
    hold("mic", null);
    hold("cam", null);
  }, [hold]);

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
    takeForJoin: () => ({ mic: live.current.mic?.clone() ?? null, cam: live.current.cam?.clone() ?? null }),
    release,
  };
}
