"use client";

/**
 * components/meet/MeetRoomLive.tsx - the room page's client entry: MeetRoom with the host-browser recorder
 * (lib/meet/recorder.ts) plugged in. The server page cannot hand a client component a function, so the recorder
 * is made here. It only ever runs in the one browser the room names its recorder (a host's, in a recorded room;
 * lib/meet/room-client.ts startRecorder), which can change mid-call, and End stops it before the room ends.
 */
import { createMeetRecorder } from "@/lib/meet/recorder";
import { MeetRoom, type MeetRoomProps } from "./MeetRoom";

export function MeetRoomLive(props: Omit<MeetRoomProps, "recorder">) {
  return <MeetRoom {...props} recorder={() => createMeetRecorder({ code: props.code })} />;
}
