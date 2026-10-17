"use client";

/**
 * components/meet/MeetRoom.tsx - an Oasis Meet room in the browser, from the pre-join screen to the end.
 *
 * It owns the room's controller (lib/meet/room-client.ts, no React) and draws its snapshot with
 * useSyncExternalStore: the pre-join screen while idle or after a failed join, "Joining..." and the host wait
 * between, the call itself while live, and the plain ending screens. The name, the recording tick and the camera
 * preview live HERE, so a join that fails comes back to the pre-join screen exactly as the person left it.
 *
 * The recording notice rule is applied in one place below (components/meet/notice.ts): `devicesOpen` is what
 * lets the camera step exist at all, and the hook that asks for the devices refuses while it is false.
 *
 * `recorder` is the host's recording engine (lib/meet/recorder.ts), wired by the page that mounts this once it
 * exists; without it the room simply does not record.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createMeetRoomController, type RecorderPort } from "@/lib/meet/room-client";
import { CallScreen } from "./CallScreen";
import { Lobby } from "./Lobby";
import { MeetEnded } from "./MeetEnded";
import { mayAskForDevices, preJoinNeeds, type MeetViewer } from "./notice";
import { PreJoin } from "./PreJoin";
import { useJoinDevices } from "./useJoinDevices";

export type MeetRoomProps = {
  /** The dashed code, "abc-defg-hjk". */
  code: string;
  title: string;
  status: "scheduled" | "live" | "ended";
  recordAudio: boolean;
  viewer: MeetViewer;
  /** Made for the host in a recorded room once they are in the call. */
  recorder?: () => RecorderPort;
};

const IN_CALL = new Set(["joining", "waiting_for_host", "connecting", "live"]);

export function MeetRoom({ code, title, status, recordAudio, viewer, recorder }: MeetRoomProps) {
  // One controller for the life of the page. `recorder` is read once, when the room is made.
  const [controller] = useState(() => createMeetRoomController({ code, recorder }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const phase = snapshot.phase;

  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [tried, setTried] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);

  const failure = phase.kind === "failed" ? phase.error : null;
  const needs = preJoinNeeds({ viewer, recordAudio, failedCode: phase.kind === "failed" ? (phase.code ?? null) : null });
  const needsNotice = needs.notice;
  const nameRequired = needs.name;
  const devicesOpen = mayAskForDevices({ needsNotice, ticked: consent });
  const devices = useJoinDevices(devicesOpen);
  const releaseDevices = devices.release;

  // Screen sharing does not exist on phones; this is only known in the browser, so it appears after mount.
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function");
  }, []);

  // Closing or leaving the page ends the person's place in the call at once, not after the room times them out.
  // Unmounting while in the call (not a page unload) leaves properly too, so no camera or poll is left running.
  useEffect(() => {
    const inCall = () => IN_CALL.has(controller.snapshot().phase.kind);
    const onHide = () => {
      if (inCall() && typeof navigator.sendBeacon === "function") navigator.sendBeacon(`/api/meet/${code}/leave`);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (inCall()) void controller.leave();
    };
  }, [controller, code]);

  // The call is over for this person: the room has stopped its own copies, and ours go too.
  useEffect(() => {
    if (phase.kind === "ended") releaseDevices();
  }, [phase.kind, releaseDevices]);

  const join = async () => {
    if (devices.asking) return;
    setTried(true);
    const trimmed = name.trim();
    // The first thing still missing, in the order the screen asks for it: the notice, then the name.
    if (needsNotice && !consent) {
      consentRef.current?.focus();
      return;
    }
    if (nameRequired && !trimmed) {
      nameRef.current?.focus();
      return;
    }
    const held = devices.takeForJoin();
    await controller.join({ name: trimmed || undefined, consent: needsNotice ? consent : false, mic: held.mic, cam: held.cam });
    // The room keeps its own copies of the tracks. If the join failed it stopped them, ours still run for another try.
    if (controller.snapshot().phase.kind !== "failed") releaseDevices();
  };

  const isHost = viewer === "host" || snapshot.me?.role === "host";
  const heading = snapshot.room?.title ?? title;

  if (status === "ended") return <MeetEnded reason="room_closed" isHost={isHost} title={title} />;

  switch (phase.kind) {
    case "ended":
      return <MeetEnded reason={phase.reason} isHost={isHost} title={heading} />;
    case "live":
      return <CallScreen controller={controller} snapshot={snapshot} code={code} title={title} recordAudio={recordAudio} canShare={canShare} />;
    case "joining":
      return <Lobby mode="joining" title={heading} preview={null} />;
    case "connecting":
      return (
        <Lobby
          mode="connecting"
          title={heading}
          preview={snapshot.tiles.find((t) => t.me)?.video ?? null}
          onLeave={() => void controller.leave()}
        />
      );
    case "waiting_for_host":
      return (
        <Lobby
          mode="waiting"
          title={heading}
          preview={snapshot.tiles.find((t) => t.me)?.video ?? null}
          onLeave={() => void controller.leave()}
        />
      );
    default:
      return (
        <PreJoin
          title={title}
          recordAudio={recordAudio}
          needsNotice={needsNotice}
          nameRequired={nameRequired}
          name={name}
          onName={setName}
          consent={consent}
          onConsent={setConsent}
          devicesOpen={devicesOpen}
          devices={devices}
          error={failure}
          nameMissing={tried && nameRequired && !name.trim()}
          consentMissing={tried && needsNotice && !consent}
          nameRef={nameRef}
          consentRef={consentRef}
          onJoin={() => void join()}
        />
      );
  }
}
