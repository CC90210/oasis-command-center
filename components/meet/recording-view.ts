/**
 * components/meet/recording-view.ts - what a meeting's recording panel says
 * and does, with no React in it, so tests/meet-recording.test.ts can hold every
 * line and every action to the server's state (components/meet/MeetRecording.tsx
 * is the screen around it; lib/meet/recording.ts meetRecordingView is the state).
 *
 * The rule the panel lives by: it says something happened only when it did.
 * Deleted from the Command Center is not deleted from the computer; a delete
 * the server has not finished is still deleting; an action that failed says so
 * after the panel has re-read the recording, never before (Codex on #685).
 */

export type RecordingLine = { at_ms: number; end_ms: number; participant_id: string; speaker: string; text: string };

export type RecordingState =
  | "lost"
  | "unavailable"
  | "off"
  | "none"
  | "recording"
  | "waiting"
  | "transcribing"
  | "ready"
  | "failed"
  | "expired"
  | "deleted";

/** GET /api/meet/<code>/recording's `recording` (lib/meet/recording.ts MeetRecordingView). */
export type RecordingView = {
  state: RecordingState;
  relayChunks: number;
  relayBytes: number;
  missingChunks: number;
  recorderErrored: number;
  relayExpiresAt: string | null;
  job: { status: string; stage: string | null; errorCode: string | null; attempts: number } | null;
  runner: { label: string; lastSeenAt: string } | null;
  transcript: {
    lines: RecordingLine[];
    text: string | null;
    startedAtMs: number | null;
    model: string | null;
    deviceLabel: string | null;
    folderName: string | null;
    readyAt: string | null;
    transcribeSeconds: number | null;
  } | null;
  deviceDelete: { status: "not_needed" | "waiting" | "done" | "failed"; errorCode: string | null; doneAt: string | null } | null;
};

export const PC = "OASIS's computer";
/** How many times one Delete asks the server again while relay copies are left (it deletes a batch per call). */
export const DELETE_ROUNDS = 20;

const ACTIVE: ReadonlySet<RecordingState> = new Set(["recording", "waiting", "transcribing"]);
const DELETABLE: ReadonlySet<RecordingState> = new Set(["waiting", "transcribing", "failed", "ready"]);

/** Why a transcription, or the computer's delete, stopped (lib/tools/errors.ts codes). */
export const FAILED_BECAUSE: Readonly<Record<string, string>> = {
  attempts_exhausted: "the computer stopped three times before it finished",
  download_failed: "the computer couldn't download all of the audio",
  transcode_failed: "the computer couldn't read the audio",
  transcribe_failed: "the transcription itself failed",
  ffmpeg_missing: "the computer is missing its audio tools",
  meeting_gone: "the recording was no longer waiting",
  unsafe_path: "its folder was not where meetings are kept, so it was left alone",
};

/** Seconds of audio in one chunk (lib/meet/recorder.ts DEFAULT_TIMESLICE_MS). */
const CHUNK_SECONDS = 10;

/**
 * How much audio never made it into the transcript, from the real count of
 * missing chunks (each about 10 seconds), or null when none is missing. Never
 * "a few moments" for what may be most of a speaker's meeting (#685 review, M2).
 */
export function missingAudioLine(v: RecordingView): string | null {
  if (!(v.missingChunks > 0)) {
    return v.recorderErrored > 0
      ? "The recording browser reported a problem during the call, so part of the audio may be missing from this transcript."
      : null;
  }
  const seconds = v.missingChunks * CHUNK_SECONDS;
  const amount = seconds < 120 ? `about ${seconds} seconds` : `about ${Math.round(seconds / 60)} minutes`;
  return `Some audio didn't reach the server during the call: ${amount} of it is missing from this transcript.`;
}

/** Something is still happening, so the panel reads the recording again in a while. */
export function recordingBusy(v: RecordingView): boolean {
  if (ACTIVE.has(v.state)) return true;
  if (v.state !== "deleted" && v.state !== "expired") return false;
  return v.relayChunks > 0 || v.deviceDelete?.status === "waiting";
}

/** Delete is offered while there is something to delete, and again when the computer could not delete its copy. */
export function recordingDeletable(v: RecordingView): boolean {
  return DELETABLE.has(v.state) || ((v.state === "deleted" || v.state === "expired") && v.deviceDelete?.status === "failed");
}

/** The line about the computer's own copy, once the recording is deleted or expired. */
function deviceLine(view: RecordingView, fallback: string | null): string | null {
  const device = view.deviceDelete;
  if (device?.status === "waiting") return `Waiting for ${PC} to delete its copy. It does when it's next on.`;
  if (device?.status === "done") return "The computer's copy was deleted too.";
  if (device?.status === "failed") {
    const why = (device.errorCode && FAILED_BECAUSE[device.errorCode]) || "it reported an error";
    return `${PC} couldn't delete its copy: ${why}. Delete again to retry.`;
  }
  return fallback;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The panel's headline and its one line of detail, for this state. */
export function describeRecording(view: RecordingView): { headline: string; detail: string | null } {
  const where = view.runner?.label ?? PC;
  const t = view.transcript;
  switch (view.state) {
    case "unavailable":
      return {
        headline: "Meetings in this workspace aren't recorded.",
        detail: "Recording needs a computer that transcribes this workspace's meetings, and none is set up for it yet.",
      };
    case "off":
      return { headline: "Recording was off for this meeting.", detail: null };
    case "none":
      return { headline: "Nothing was recorded.", detail: null };
    case "recording":
      return { headline: "Recording. Each speaker's voice is saved as the meeting goes.", detail: null };
    case "waiting":
      return {
        headline: view.runner ? `Waiting for ${where} to transcribe it.` : `Waiting for ${PC} to come online to transcribe it.`,
        detail: view.relayExpiresAt ? `The audio is held here until ${day(view.relayExpiresAt)}, then deleted.` : null,
      };
    case "transcribing":
      return { headline: `Transcribing on ${where}.`, detail: "A long meeting takes a while: the computer transcribes it without a graphics card." };
    case "failed": {
      const why = (view.job?.errorCode && FAILED_BECAUSE[view.job.errorCode]) || "the computer couldn't finish it";
      return {
        headline: `The transcript didn't finish: ${why}.`,
        detail: view.relayExpiresAt ? `The audio is still here until ${day(view.relayExpiresAt)}. Try again, or delete it.` : null,
      };
    }
    case "ready":
      return {
        headline: "Transcript",
        detail: t?.deviceLabel ? `Audio and transcript saved on ${t.deviceLabel}${t.folderName ? `, in the folder "${t.folderName}"` : ""}.` : null,
      };
    case "expired":
      // Deleted only once it is: the relay's cleanup takes a batch per run (Codex on #685, second pass), and a PC
      // that had claimed it is told to delete its partial copy (fourth pass).
      return {
        headline:
          view.relayChunks > 0
            ? `${PC} didn't take this recording within 30 days, so its audio is being deleted without a transcript.`
            : `${PC} didn't take this recording within 30 days, so its audio was deleted without a transcript.`,
        detail: deviceLine(view, null),
      };
    case "lost":
      return {
        headline: "This meeting wasn't recorded: the recording browser couldn't upload any of the audio.",
        detail: "Check that browser's connection before the next recorded meeting.",
      };
    case "deleted": {
      // Deleted only for what is: the server's copies and the computer's copy each have their own state.
      const serverLeft = view.relayChunks > 0;
      return {
        headline: serverLeft
          ? "Deleting the recording. The transcript is gone; the audio on the server is still being removed."
          : "The recording and transcript were deleted from the Command Center.",
        detail: deviceLine(view, serverLeft ? null : "The computer never had a copy."),
      };
    }
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Try again (finalize) or Delete, against the server. Delete asks again while
 * the server says relay copies are left (it deletes a batch per call), up to
 * DELETE_ROUNDS; the relay's cron finishes whatever is left. The answer says
 * whether it worked; the panel shows a failure only AFTER it has re-read the
 * recording, so the re-read cannot wipe it.
 */
export async function runRecordingAction(
  kind: "retry" | "delete",
  base: string,
  fetchFn: Fetch,
  stillWanted: () => boolean = () => true,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const failed = kind === "retry" ? "Couldn't start the transcript again." : "Couldn't delete the recording. Try again.";
  try {
    if (kind === "retry") {
      const res = await fetchFn(`${base}/finalize`, { method: "POST", credentials: "same-origin" });
      return res.ok ? { ok: true } : { ok: false, error: failed };
    }
    for (let round = 0; round < DELETE_ROUNDS; round += 1) {
      const res = await fetchFn(base, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) return { ok: false, error: failed };
      const body = (await res.json().catch(() => null)) as { relay_remaining?: unknown } | null;
      if (!(Number(body?.relay_remaining) > 0) || !stillWanted()) break;
    }
    return { ok: true };
  } catch {
    return { ok: false, error: failed };
  }
}
