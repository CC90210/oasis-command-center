/**
 * components/meet/notice.ts - the recording notice rule, in two small functions the whole room page reads.
 *
 * THE HARD RULE (Quebec Law 25, notice before collection): in a recorded meeting, a person who is not the
 * host reads the recording notice and ticks it BEFORE the page asks the browser for their camera or
 * microphone. mayAskForDevices is the one gate: components/meet/MeetRoom.tsx hands it to the pre-join screen
 * (which draws no camera step while it is false) and to the hook that asks (which refuses while it is false),
 * and components/meet/devices.ts openDevices checks it again before it touches getUserMedia.
 * tests/meet-ui.test.ts holds all three. No React.
 */

/** How the page sees the person: the host, a signed-in member of the workspace who is not the host, or anyone else. */
export type MeetViewer = "host" | "member" | "visitor";

/** Must this person read and tick the recording notice before they join? Everyone but the host, in a recorded room. */
export function needsRecordingNotice(input: { viewer: MeetViewer; recordAudio: boolean }): boolean {
  return input.recordAudio && input.viewer !== "host";
}

/** May the page ask the browser for the camera or microphone yet? Not until the notice is ticked, when there is one. */
export function mayAskForDevices(input: { needsNotice: boolean; ticked: boolean }): boolean {
  return !input.needsNotice || input.ticked;
}

/**
 * What the pre-join screen must ask for: the recording notice (by the rule above, or because a join came back
 * consent_required) and a name (a visitor always, or a join that came back name_required). A host whose session
 * ran out between loading the page and Join now is refused as a guest; this shows the field the server asked for,
 * read from the answer's code, never from its words.
 */
export function preJoinNeeds(input: { viewer: MeetViewer; recordAudio: boolean; failedCode: string | null }): { notice: boolean; name: boolean } {
  return {
    notice: needsRecordingNotice(input) || input.failedCode === "consent_required",
    name: input.viewer === "visitor" || input.failedCode === "name_required",
  };
}
