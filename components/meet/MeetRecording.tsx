"use client";
/**
 * components/meet/MeetRecording.tsx - a meeting's recording and transcript, for
 * the Meet panel (GET and DELETE /api/meet/<code>/recording, POST
 * .../recording/finalize; lib/meet/recording.ts).
 *
 * It always says where the audio is: on the relay waiting for OASIS's computer
 * (and until when), or on that computer, in which folder. One read on arrival;
 * it reads again every 15 seconds only while something is still happening.
 * Delete asks on the card itself, never with a browser dialog.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Loader2, RotateCcw, Trash2 } from "lucide-react";

type Line = { at_ms: number; end_ms: number; participant_id: string; speaker: string; text: string };

type State = "off" | "none" | "recording" | "waiting" | "transcribing" | "ready" | "failed" | "expired" | "deleted";

type View = {
  state: State;
  relayChunks: number;
  relayBytes: number;
  missingChunks: number;
  relayExpiresAt: string | null;
  job: { status: string; stage: string | null; errorCode: string | null; attempts: number } | null;
  runner: { label: string; lastSeenAt: string } | null;
  transcript: {
    lines: Line[];
    text: string | null;
    startedAtMs: number | null;
    model: string | null;
    deviceLabel: string | null;
    folderName: string | null;
    readyAt: string | null;
    transcribeSeconds: number | null;
  } | null;
  deviceDeletedAt: string | null;
};

const POLL_MS = 15_000;
const ACTIVE: ReadonlySet<State> = new Set(["recording", "waiting", "transcribing"]);
const DELETABLE: ReadonlySet<State> = new Set(["waiting", "transcribing", "failed", "ready"]);
const PC = "OASIS's computer";

/** Why a transcription stopped, in words (lib/tools/errors.ts codes). */
const FAILED_BECAUSE: Readonly<Record<string, string>> = {
  attempts_exhausted: "the computer stopped three times before it finished",
  download_failed: "the computer couldn't download all of the audio",
  transcode_failed: "the computer couldn't read the audio",
  transcribe_failed: "the transcription itself failed",
  ffmpeg_missing: "the computer is missing its audio tools",
  meeting_gone: "the recording was no longer waiting",
};

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function MeetRecording({ code }: { code: string }) {
  const base = `/api/meet/${encodeURIComponent(code)}/recording`;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { credentials: "same-origin", cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; recording?: View } | null;
      if (!alive.current) return;
      if (!res.ok || !body?.ok || !body.recording) {
        setError("Couldn't load this meeting's recording. Reload to try again.");
        return;
      }
      setError(null);
      setView(body.recording);
    } catch {
      if (alive.current) setError("Couldn't load this meeting's recording. Reload to try again.");
    }
  }, [base]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const state = view?.state;
  useEffect(() => {
    if (!state || !ACTIVE.has(state)) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [state, load]);

  async function act(kind: "retry" | "delete") {
    if (busy) return;
    setBusy(kind);
    try {
      const res = await fetch(kind === "retry" ? `${base}/finalize` : base, {
        method: kind === "retry" ? "POST" : "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) setError(kind === "retry" ? "Couldn't start the transcript again." : "Couldn't delete the recording. Try again.");
      setConfirming(false);
      await load();
    } catch {
      setError(kind === "retry" ? "Couldn't start the transcript again." : "Couldn't delete the recording. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    const t = view?.transcript;
    if (!t) return;
    const zero = t.startedAtMs ?? t.lines[0]?.at_ms ?? 0;
    const text = t.text || t.lines.map((l) => `[${clock(l.at_ms - zero)}] ${l.speaker}: ${l.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the transcript and copy it instead.");
    }
  }

  if (!view) {
    return (
      <section aria-label="Recording" className="rounded-xl border border-bg-border bg-bg-panel p-4 text-xs text-fg-muted">
        {error ?? "Loading the recording..."}
      </section>
    );
  }

  const button =
    "inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-xs font-semibold text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40";
  const where = view.runner?.label ?? PC;
  const t = view.transcript;
  const zero = t ? (t.startedAtMs ?? t.lines[0]?.at_ms ?? 0) : 0;

  let headline: string;
  let detail: string | null = null;
  switch (view.state) {
    case "off":
      headline = "Recording was off for this meeting.";
      break;
    case "none":
      headline = "Nothing was recorded.";
      break;
    case "recording":
      headline = "Recording. Each speaker's voice is saved as the meeting goes.";
      break;
    case "waiting":
      headline = view.runner ? `Waiting for ${where} to transcribe it.` : `Waiting for ${PC} to come online to transcribe it.`;
      detail = view.relayExpiresAt ? `The audio is held here until ${day(view.relayExpiresAt)}, then deleted.` : null;
      break;
    case "transcribing":
      headline = `Transcribing on ${where}.`;
      detail = "A long meeting takes a while: the computer transcribes it without a graphics card.";
      break;
    case "failed": {
      const why = (view.job?.errorCode && FAILED_BECAUSE[view.job.errorCode]) || "the computer couldn't finish it";
      headline = `The transcript didn't finish: ${why}.`;
      detail = view.relayExpiresAt ? `The audio is still here until ${day(view.relayExpiresAt)}. Try again, or delete it.` : null;
      break;
    }
    case "ready":
      headline = "Transcript";
      detail =
        t?.deviceLabel
          ? `Audio and transcript saved on ${t.deviceLabel}${t.folderName ? `, in the folder "${t.folderName}"` : ""}.`
          : null;
      break;
    case "expired":
      headline = `${PC} didn't take this recording within 30 days, so its audio was deleted without a transcript.`;
      break;
    case "deleted":
      headline = "The recording and transcript were deleted.";
      detail = view.deviceDeletedAt ? "The computer's copy was deleted too." : null;
      break;
  }

  return (
    <section aria-label="Recording" className="space-y-3 rounded-xl border border-bg-border bg-bg-panel p-4">
      <div className="space-y-1">
        <h3 className="break-words text-sm font-semibold text-fg">{headline}</h3>
        {detail && <p className="break-words text-xs leading-5 text-fg-muted">{detail}</p>}
        {view.state === "ready" && view.missingChunks > 0 && (
          <p className="text-xs leading-5 text-fg-muted">
            Some audio didn&apos;t reach the server during the call, so a few moments are missing from this transcript.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs leading-5 text-red-500">
            {error}
          </p>
        )}
      </div>

      {t && (
        <>
          {t.lines.length === 0 ? (
            <p className="text-xs text-fg-muted">No speech was heard in this recording.</p>
          ) : (
            <ol className="max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm leading-6">
              {t.lines.map((l, i) => (
                <li key={`${l.participant_id}-${l.at_ms}-${i}`} className="break-words">
                  <span className="mr-2 font-mono text-[11px] text-fg-dim">{clock(l.at_ms - zero)}</span>
                  <span className="font-semibold text-fg">{l.speaker}:</span> <span className="text-fg-muted">{l.text}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {t && t.lines.length > 0 && (
          <button type="button" onClick={() => void copy()} className={button}>
            <Copy aria-hidden className="h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy transcript"}
          </button>
        )}
        {view.state === "failed" && (
          <button type="button" onClick={() => void act("retry")} disabled={busy !== null} className={button}>
            {busy === "retry" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw aria-hidden className="h-3.5 w-3.5" />}
            Try again
          </button>
        )}
        {DELETABLE.has(view.state) &&
          (confirming ? (
            <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              Delete the recording and transcript here and on {where}?
              <button type="button" onClick={() => void act("delete")} disabled={busy !== null} className={button}>
                {busy === "delete" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Trash2 aria-hidden className="h-3.5 w-3.5" />}
                Delete
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy !== null} className={button}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null} className={button}>
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              Delete recording
            </button>
          ))}
      </div>
    </section>
  );
}
