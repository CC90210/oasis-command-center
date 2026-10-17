"use client";
/**
 * components/meet/MeetRecording.tsx - a meeting's recording and transcript, for
 * the Meet panel (GET and DELETE /api/meet/<code>/recording, POST
 * .../recording/finalize; lib/meet/recording.ts).
 *
 * It always says where the audio is: on the relay waiting for OASIS's computer
 * (and until when), or on that computer, in which folder. One read on arrival;
 * it reads again every 15 seconds only while something is still happening.
 * Delete asks on the card itself, never with a browser dialog. What it says,
 * when it polls and how its actions run live in ./recording-view.ts, where the
 * tests hold them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Loader2, RotateCcw, Trash2 } from "lucide-react";
import {
  PC,
  clock,
  describeRecording,
  missingAudioLine,
  recordingBusy,
  recordingDeletable,
  runRecordingAction,
  type RecordingView,
} from "./recording-view";

const POLL_MS = 15_000;
const LOAD_FAILED = "Couldn't load this meeting's recording. Reload to try again.";

/**
 * One panel per meeting: keyed by its code, so nothing (a view, an open Delete
 * confirmation, an error, a late answer) carries over when the parent shows
 * another meeting in the same place (#685 review, M4).
 */
export function MeetRecording({ code }: { code: string }) {
  return <MeetRecordingPanel key={code} code={code} />;
}

function MeetRecordingPanel({ code }: { code: string }) {
  const base = `/api/meet/${encodeURIComponent(code)}/recording`;
  const [view, setView] = useState<RecordingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  /** Read the recording again. Clears a previous load error, never an action's (`keepError`). */
  const load = useCallback(
    async (keepError = false) => {
      try {
        const res = await fetch(base, { credentials: "same-origin", cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; recording?: RecordingView } | null;
        if (!alive.current) return;
        if (!res.ok || !body?.ok || !body.recording) {
          setError(LOAD_FAILED);
          return;
        }
        if (!keepError) setError(null);
        setView(body.recording);
      } catch {
        if (alive.current) setError(LOAD_FAILED);
      }
    },
    [base],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const polling = view ? recordingBusy(view) : false;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  async function act(kind: "retry" | "delete") {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const outcome = await runRecordingAction(kind, base, (input, init) => fetch(input, init), () => alive.current);
      setConfirming(false);
      await load(true);
      // After the re-read, so the re-read can never wipe it.
      if (!outcome.ok && alive.current) setError(outcome.error);
    } finally {
      if (alive.current) setBusy(null);
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
  const { headline, detail } = describeRecording(view);

  return (
    <section aria-label="Recording" className="space-y-3 rounded-xl border border-bg-border bg-bg-panel p-4">
      <div className="space-y-1">
        <h3 className="break-words text-sm font-semibold text-fg">{headline}</h3>
        {detail && <p className="break-words text-xs leading-5 text-fg-muted">{detail}</p>}
        {view.state === "ready" && missingAudioLine(view) && <p className="text-xs leading-5 text-fg-muted">{missingAudioLine(view)}</p>}
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
        {recordingDeletable(view) &&
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
