/**
 * components/meet/meet-words.ts - the plain sentences on Oasis Meet's screens that more than one file says,
 * so the room, the Schedule panel and tests/meet-ui.test.ts read the same words. No React. ASCII only
 * (tests/worker-source-one-byte.test.ts): write an apostrophe as ' inside a JS string, never inside JSX text.
 */
import type { MeetEndReason } from "@/lib/meet/room-client";

export const MEET_BRAND = "Oasis Meet";

/**
 * The recording notice and the tick that agrees to it. Quebec Law 25: the person is told BEFORE anything is
 * collected, so both come before the camera and microphone step (components/meet/notice.ts).
 */
export const RECORDING_NOTICE = "This meeting is recorded and transcribed so the host has notes of it.";
export const CONSENT_LABEL = "I agree to this meeting being recorded.";
/** What the room's creator reads where everyone else reads the notice: they do not tick it, they run the recording. */
export const CREATOR_RECORDING_LINE = "This meeting is recorded and transcribed. Guests agree to this before they join.";

export const TICK_FIRST = "Tick the box above to set up your camera and microphone.";
export const DEVICES_BUTTON = "Turn on camera and microphone";
export const DEVICES_OPTIONAL = "You can also join without them.";

/** What the screen says when a meeting is over, by why the person is out (lib/meet/room-client.ts MeetEndReason). */
export const ENDED_WORDS: Record<MeetEndReason, string> = {
  left: "You left the meeting.",
  dropped: "You were disconnected from the meeting.",
  host_ended: "The host ended the meeting.",
  removed: "The host removed you from this meeting.",
  room_closed: "This meeting has ended.",
};

export const WAITING_FOR_HOST = "Waiting for the host to start the meeting.";
