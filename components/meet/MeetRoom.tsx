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
 * A meeting made for a time says when it starts, on the pre-join screen and in the waiting lobby (useStartsLine, in the
 * viewer's own time zone); a lead who booked it finds their first name already in the name field.
 *
 * `recorder` is the host's recording engine (lib/meet/recorder.ts), wired by the page that mounts this once it
 * exists; without it the room simply does not record.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createMeetRoomController, type MeetRoomOptions } from "@/lib/meet/room-client";
import { CallScreen } from "./CallScreen";
import { Lobby } from "./Lobby";
import { MeetEnded } from "./MeetEnded";
import { clampName } from "./meet-format";
import { mayAskForDevices, preJoinNeeds, type MeetViewer } from "./notice";
import { PreJoin } from "./PreJoin";
import { useJoinDevices } from "./useJoinDevices";
import { useStartsLine } from "./useStartsLine";

export type MeetRoomProps = {
  /** The dashed code, "abc-defg-hjk". */
  code: string;
  title: string;
  status: "scheduled" | "live" | "ended";
  recordAudio: boolean;
  /** Decides the name field and the host controls. */
  viewer: MeetViewer;
  /**
   * This person made the room: the only one who does not tick the recording notice (a second host does). Decided by
   * the page from the session and the room (app/meet/[code]/load.ts meetCreatorFor), never from `viewer`.
   */
  creator: boolean;
  /** When a meeting made for a time is for (ISO), else null: the pre-join screen and the waiting lobby say when it starts. */
  startsAt: string | null;
  /** The first name of the lead who booked this room, for a visitor's name field to start with (they can change it); else null. */
  guestName: string | null;
  /** Made for a host whose browser the room names its recorder, once they are in the call (lib/meet/room-client.ts). */
  recorder?: MeetRoomOptions["recorder"];
};

const IN_CALL = new Set(["joining", "waiting_for_host", "connecting", "live"]);

export function MeetRoom({ code, title, status, recordAudio, viewer, creator, startsAt, guestName, recorder }: MeetRoomProps) {
  // One controller for the life of the page. `recorder` is read once, when the room is made.
  const [controller] = useState(() => createMeetRoomController({ code, recorder }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const phase = snapshot.phase;

  // A lead who booked this meeting finds their first name already there. It is only where the field starts: they can
  // change it, and everything the field is checked for is unchanged.
  const [name, setName] = useState(() => clampName(guestName ?? ""));
  const startsLine = useStartsLine(startsAt);
  const [consent, setConsent] = useState(false);
  const [tried, setTried] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);

  const failure = phase.kind === "failed" ? phase.error : null;
  const needs = preJoinNeeds({ viewer, creator, recordAudio, failedCode: phase.kind === "failed" ? (phase.code ?? null) : null });
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
    // Only a tab that holds the room says it left: another tab of this browser shares its cookie (MeetTabs).
    const onHide = () => {
      if (controller.inRoom() && typeof navigator.sendBeacon === "function") navigator.sendBeacon(`/api/meet/${code}/leave`);
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

  // `stopWaiting`: the person chose to join with what they have rather than wait for the browser to answer. `here`: the
  // meeting is open in another tab of this browser, and they chose to move it to this one.
  const join = async (options: { stopWaiting?: boolean; here?: boolean } = {}) => {
    // Not while the browser is still answering a request for the camera or microphone: joining then would leave without
    // the camera the person just allowed. Choosing to stop waiting is the one way past this, and it passes only this.
    if (devices.asking && !options.stopWaiting) return;
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
    // Past the gates: what is still open is let go (its answer is stopped when it comes) and what is held goes in.
    if (options.stopWaiting) devices.stopWaiting();
    const held = devices.takeForJoin();
    await controller.join({ name: trimmed || undefined, consent: needsNotice ? consent : false, mic: held.mic, cam: held.cam, here: options.here });
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
      return <CallScreen controller={controller} snapshot={snapshot} code={code} title={title} canShare={canShare} />;
    case "joining":
      // The first /join on its way, or a dropped line's wait. Leave works in both: the engine ends the call at once
      // and keeps it ended whatever the join's answer, so this screen always offers a way out.
      return <Lobby mode="joining" title={heading} preview={null} onLeave={() => void controller.leave()} />;
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
          startsLine={startsLine}
          onLeave={() => void controller.leave()}
        />
      );
    default:
      return (
        <PreJoin
          title={title}
          startsLine={startsLine}
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
          onJoinWithout={() => void join({ stopWaiting: true })}
          onJoinHere={phase.kind === "failed" && phase.code === "open_in_another_tab" ? () => void join({ here: true }) : undefined}
        />
      );
  }
}
