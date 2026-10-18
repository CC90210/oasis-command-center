/**
 * components/meet/notice.ts - the recording notice rule, in a few small functions the whole room page reads.
 *
 * THE HARD RULE (Quebec Law 25, notice before collection): in a recorded meeting, a person who is not the room's
 * creator (a second host too) reads the recording notice and ticks it BEFORE the page asks the browser for their
 * camera or microphone. The creator chose to record, so they are the only one told rather than asked. The server
 * enforces the same rule on the join (lib/meet/handlers.ts handleJoin refuses a recorded room without the tick
 * from anyone but the creator), so this page asks before the camera and the server asks again at the door.
 * mayAskForDevices is the one gate: components/meet/MeetRoom.tsx hands it to the pre-join screen (which draws no
 * camera step while it is false) and to the hook that asks (which refuses while it is false), and
 * components/meet/devices.ts openDevices checks it again before it touches getUserMedia.
 * tests/meet-ui.test.ts holds all three. No React.
 */

/**
 * How the page sees the person: the host (the room's creator, or an owner or admin of its workspace), a signed-in
 * member of the workspace who is not the host, or anyone else. It decides the name field and the host controls,
 * never the recording notice: that depends on `creator` alone.
 */
export type MeetViewer = "host" | "member" | "visitor";

/**
 * Must this person read and tick the recording notice before they join? Everyone but the room's creator, in a
 * recorded room. `creator` is true only for the person who made the room (app/meet/[code]/load.ts meetCreatorFor),
 * so a second host (a "host" viewer who did not make it) is asked like a guest.
 */
export function needsRecordingNotice(input: { recordAudio: boolean; creator: boolean }): boolean {
  return input.recordAudio && !input.creator;
}

/** May the page ask the browser for the camera or microphone yet? Not until the notice is ticked, when there is one. */
export function mayAskForDevices(input: { needsNotice: boolean; ticked: boolean }): boolean {
  return !input.needsNotice || input.ticked;
}

/**
 * What the pre-join screen must ask for: the recording notice (by the rule above, or because a join came back
 * consent_required) and a name (a visitor always, or a join that came back name_required). A creator whose session
 * ran out between loading the page and Join now is refused as a guest; this shows the field the server asked for,
 * read from the answer's code, never from its words.
 */
export function preJoinNeeds(input: { viewer: MeetViewer; creator: boolean; recordAudio: boolean; failedCode: string | null }): { notice: boolean; name: boolean } {
  return {
    notice: needsRecordingNotice(input) || input.failedCode === "consent_required",
    name: input.viewer === "visitor" || input.failedCode === "name_required",
  };
}
