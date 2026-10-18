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
