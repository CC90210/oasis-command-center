/**
 * lib/meet/recording-notice.ts - the one sentence that tells a person booking a call that it will be recorded.
 *
 * Maven's wording, CC approved 2026-10-18. It goes wherever a booked call is confirmed: the Google invite (under
 * "Join the video call"), the booking confirmation screen and the Instagram DM confirmation. Shown only when the
 * call's Oasis Meet room records (meet_rooms.record_audio): a Google Meet fallback, or a workspace that does not
 * record, has no consent step, and the sentence would be false there. No server-only import: the booking calendar
 * (a client component) renders it too.
 */
export const MEET_RECORDING_NOTICE = "We record and transcribe this call for our notes. You'll be asked to agree when you join.";

/**
 * A confirmation line, then the notice as its own sentence when the call is recorded. A line that does not end its
 * sentence (a workspace's custom thanks message, Maven's review) gets a full stop first, so the two never run
 * together. Unrecorded, the line comes back exactly as given.
 */
export function withRecordingNotice(line: string, recorded: boolean): string {
  if (!recorded) return line;
  const text = line.trim();
  if (!text) return MEET_RECORDING_NOTICE;
  return `${SENTENCE_END.test(text) ? text : `${text}.`} ${MEET_RECORDING_NOTICE}`;
}

/**
 * A line that already ends its sentence: . ! ? or an ellipsis (U+2026), interrobang (U+203D), or full-width stop,
 * exclamation or question mark, then any closing quotes or brackets, straight or typographic (U+2019, U+201D, U+00BB).
 * A custom thanks message is the workspace's own words, so "See you soon\u2026" or a closing curly quote is a finished
 * sentence (Codex on the confirmation copy PR). Escapes keep this file ASCII.
 */
const SENTENCE_END = /[.!?\u2026\u203d\u3002\uff01\uff1f]["'\u2019\u201d\u00bb)\]]*$/;
