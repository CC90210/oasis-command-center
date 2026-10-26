"use client";

/**
 * The engagement's "Call and transcripts" tab: the live-call screen's door,
 * the call's transcripts with their consent, and Gate 1.
 *
 * A transcript is added only for a call the client agreed to record; CC ticks
 * that, and separately says whether the client agreed to AI analysis (no
 * default: the answer must be chosen, again for each transcript). Gate 1 binds
 * the profile, the transcripts and the call notes as they are; any later change
 * withdraws the card and CC asks again. Only the workspace owner can approve
 * it, in Needs you, and only the owner can delete a transcript.
 *
 * "View lines" shows exactly what is stored, with the places where a possible
 * password or account detail was taken out, so CC reads what he authorizes.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EngagementView } from "@/lib/ai-audit/view";
import { AI_ENGINE_LABELS, type AiEngine } from "@/lib/ai-audit/authorize-payload";
import { CREDENTIAL_MARKER, TRANSCRIPT_MAX_BYTES, type TranscriptLine } from "@/lib/ai-audit/transcript";
import { PROFILE_EDIT_STAGES } from "@/lib/ai-audit/rules";
import { describeError, postAction, postJson } from "./api";

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const SOURCE_WORDS: Record<string, string> = { paste: "Pasted", upload: "Uploaded", meet: "Oasis Meet" };

/** A stored line, with each place a possible password or account detail was taken out marked. */
function Marked({ text }: { text: string }) {
  const parts = text.split(CREDENTIAL_MARKER);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 ? <span className="font-semibold text-status-warm">[taken out: possible password or account detail]</span> : null}
        </span>
      ))}
    </>
  );
}

/** The transcript exactly as stored (read-only). */
function TranscriptLines({ engagementId, transcriptId }: { engagementId: string; transcriptId: string }) {
  const [state, setState] = useState<{ lines: TranscriptLine[] } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/ai-audit/${encodeURIComponent(engagementId)}/transcript?id=${encodeURIComponent(transcriptId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok?: boolean; transcript?: { lines?: TranscriptLine[] } }) => {
        if (live) setState(j?.ok && Array.isArray(j.transcript?.lines) ? { lines: j.transcript.lines } : { error: "Could not load the stored lines. Reload and try again." });
      })
      .catch(() => {
        if (live) setState({ error: "Could not load the stored lines. Reload and try again." });
      });
    return () => {
      live = false;
    };
  }, [engagementId, transcriptId]);
  if (!state) return <div className="text-[12px] text-fg-dim">Loading the stored lines.</div>;
  if ("error" in state) return <div className="text-[12px] text-status-warm">{state.error}</div>;
  return (
    <ol className="max-h-80 overflow-y-auto rounded-md border border-hairline bg-bg p-2 font-mono text-[12px] leading-5" aria-label="Stored transcript lines">
      {state.lines.map((l) => (
        <li key={l.n} className="grid grid-cols-[auto_1fr] gap-x-3">
          <span className="whitespace-nowrap tabular-nums text-fg-dim">
            L{l.n}
            {l.t ? ` ${l.t}` : ""}
          </span>
          <span className="min-w-0 break-words text-fg">
            {l.speaker ? <span className="text-fg-muted">{l.speaker}: </span> : null}
            <Marked text={l.text} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function DiscoveryPanel({ view, isOwner }: { view: EngagementView; isOwner: boolean }) {
  const router = useRouter();
  const e = view.engagement;
  const [mode, setMode] = useState<"paste" | "upload">("paste");
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [ai, setAi] = useState<"" | "yes" | "no">("");
  const [engine, setEngine] = useState<AiEngine>(view.settings.engine);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const open = PROFILE_EDIT_STAGES.includes(e.stage);
  const auth = view.authorization;
  // A frozen profile after a move back is copied into a new draft when CC asks (lib/ai-audit/authorize.ts).
  const canAsk = (e.stage === "call_completed" || e.stage === "transcript_review") && (view.profile?.fields.length ?? 0) > 0;

  async function onFile(file: File | null) {
    setMessage(null);
    if (!file) return;
    if (!/\.(txt|vtt|srt)$/i.test(file.name)) {
      setMessage("Use a .txt, .vtt or .srt file. Most meeting tools export one of these.");
      return;
    }
    if (file.size > TRANSCRIPT_MAX_BYTES) {
      setMessage("That file is over 500 KB. Split it, or paste the part of the call that matters.");
      return;
    }
    setFilename(file.name);
    setText(await file.text());
  }

  async function addTranscript() {
    setMessage(null);
    if (!recording) {
      setMessage("Tick that the client agreed to the recording first. Without it, work from your notes instead.");
      return;
    }
    if (!ai) {
      setMessage("Say whether the client agreed to AI analysis.");
      return;
    }
    setBusy(true);
    const r = await postJson(`/api/ai-audit/${encodeURIComponent(e.id)}/transcript`, {
      text,
      source: mode,
      filename: mode === "upload" ? filename : null,
      consent_recording: true,
      consent_ai: ai === "yes",
    });
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    const t = r.transcript as { lines: number; redactions: number } | undefined;
    setText("");
    setFilename(null);
    // Consent is answered for each transcript, never carried over to the next one.
    setRecording(false);
    setAi("");
    setMessage(
      r.duplicate
        ? "That transcript is already on this engagement."
        : `Added: ${t?.lines ?? 0} lines.${t?.redactions ? ` ${t.redactions === 1 ? "1 possible password or account detail was" : `${t.redactions} possible passwords or account details were`} taken out. If the client needs to give access, use Connections or the secure intake form.` : ""} Read the stored lines (View lines) before you ask for authorization.`,
    );
    router.refresh();
  }

  async function act(action: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    const r = await postAction(e.id, action, body);
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    setMessage(done);
    router.refresh();
  }

  return (
    <div className="grid gap-5">
      {message ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg">{message}</div> : null}

      <section className="grid gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
        <h2 className="text-sm font-semibold text-fg">The call</h2>
        <p className="text-fg-muted">
          Run the call from the live-call screen: the questions in the handbook&apos;s order, your notes saved as you type, and what the audit still needs.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/ai-audit/${e.id}/call`} className="btn-primary">
            Open the live-call screen
          </Link>
          <Link href="/playbook/ai-audit-discovery-handbook" className="btn-secondary">
            Discovery Call Handbook
          </Link>
        </div>
        <div className="text-fg-muted">
          {e.call_started_at ? `Call started ${when(e.call_started_at)}${e.call_ended_at ? `, ended ${when(e.call_ended_at)}` : ", not ended yet"}.` : "The call has not been started on the live-call screen."}
          {view.callNotes.length ? ` Notes on ${view.callNotes.filter((n) => n.notes.trim()).length} questions.` : ""}
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
        <h2 className="text-sm font-semibold text-fg">Transcripts</h2>
        {view.transcripts.length === 0 ? <div className="text-fg-muted">No transcript yet. Paste or upload the call&apos;s transcript below.</div> : null}
        <ul className="grid gap-2">
          {view.transcripts.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2">
              <div className="min-w-0">
                <div className="text-fg">
                  {SOURCE_WORDS[t.source] ?? t.source}
                  {t.filename ? `: ${t.filename}` : ""}, {t.line_count} lines
                  {t.speakers.length ? `, ${t.speakers.slice(0, 4).join(", ")}${t.speakers.length > 4 ? " and others" : ""}` : ""}
                </div>
                <div className="text-[12px] text-fg-muted">
                  Recording agreed. AI analysis {t.consent_ai ? "agreed" : <span className="text-status-warm">not agreed</span>}
                  {t.consent_basis === "founder_attested" ? " (attested by another founder)" : ""}. Added {when(t.created_at)}
                  {t.redactions ? <span className="text-status-warm"> {t.redactions === 1 ? "1 possible password or account detail" : `${t.redactions} possible passwords or account details`} taken out.</span> : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" aria-expanded={viewing === t.id} onClick={() => setViewing(viewing === t.id ? null : t.id)}>
                  {viewing === t.id ? "Hide lines" : "View lines"}
                </button>
                {/* Only the owner deletes, at any stage: a client may ask at any time. After Gate 1 it voids the authorization. */}
                {isOwner ? (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => {
                      const warn = open
                        ? "Delete this transcript? Its lines are wiped for good, and the short quotes the profile took from it are cleared."
                        : "Delete this transcript? Its lines are wiped for good, the profile's quotes from it are cleared, and the authorization you gave no longer holds: nothing more is researched or delivered until you move the engagement back and authorize again.";
                      if (!window.confirm(warn)) return;
                      void act("delete_transcript", { transcript_id: t.id }, "Transcript deleted.");
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
              {viewing === t.id ? (
                <div className="basis-full">
                  <TranscriptLines engagementId={e.id} transcriptId={t.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        {open ? (
          <div className="grid gap-3 border-t border-hairline pt-3">
            <div className="flex gap-1" role="tablist" aria-label="Add a transcript">
              {(["paste", "upload"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "btn-secondary" : "rounded-md px-3 py-1.5 text-sm text-fg-muted hover:text-fg"} onClick={() => setMode(m)}>
                  {m === "paste" ? "Paste text" : "Upload a file"}
                </button>
              ))}
            </div>
            {mode === "paste" ? (
              <textarea className="textarea" style={{ minHeight: 160 }} placeholder={"Dana: We get about forty calls a week.\nCC: How do you know?"} value={text} onChange={(ev) => setText(ev.target.value)} />
            ) : (
              <div className="grid gap-1">
                <input type="file" accept=".txt,.vtt,.srt,text/plain,text/vtt" onChange={(ev) => void onFile(ev.target.files?.[0] ?? null)} />
                <div className="text-[12px] text-fg-dim">{filename ? `${filename} ready.` : ".txt, .vtt or .srt, up to 500 KB."}</div>
              </div>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={recording} onChange={(ev) => setRecording(ev.target.checked)} />
              <span>The client agreed to this call being recorded and transcribed.</span>
            </label>
            <fieldset className="grid gap-1">
              <legend className="text-fg">Did the client agree to AI analysis of the call for their audit?</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="ai-consent" checked={ai === "yes"} onChange={() => setAi("yes")} /> Yes
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="ai-consent" checked={ai === "no"} onChange={() => setAi("no")} /> No: I will write the audit myself
              </label>
            </fieldset>
            <button type="button" className="btn-primary justify-self-start" disabled={busy || !text.trim()} onClick={addTranscript}>
              Add transcript
            </button>
            <p className="text-[12px] text-fg-dim">
              What looks like a password, a PIN, a card or account number or a key is taken out before the transcript is stored. No check catches every way a person can say one, so read the stored lines before you authorize them.
            </p>
          </div>
        ) : (
          <div className="text-[12px] text-fg-dim">The profile is authorized, so transcripts can no longer be added. Move the engagement back to Transcript Awaiting Approval to change them.</div>
        )}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
        <h2 className="text-sm font-semibold text-fg">Gate 1: authorize the client&apos;s information</h2>
        <p className="text-fg-muted">
          Nothing is researched or written until you authorize the discovery profile, the transcripts and your call notes as they are now. Only the workspace owner can approve it.
        </p>
        <div className="text-fg-muted">
          AI analysis: <span className="text-fg">{view.consentAi ? "the client agreed" : "not agreed, so no AI service will receive their information"}</span>
        </div>
        {view.gaps.length ? (
          <div className="text-fg-muted">
            Still missing ({view.gaps.length}): <span className="text-fg">{view.gaps.map((g) => g.label).join(", ")}</span>. The audit lists missing answers as information gaps; it never guesses them.
          </div>
        ) : (
          <div className="text-fg-muted">Every essential answer is in the profile.</div>
        )}
        {view.consentAi ? (
          <div>
            <div className="label">Who processes it</div>
            <select className="select" value={engine} onChange={(ev) => setEngine(ev.target.value as AiEngine)}>
              {(["mac_claude", "cloud_workspace"] as const).map((k) => (
                <option key={k} value={k}>
                  {AI_ENGINE_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {auth ? (
          <div className="text-fg-muted">
            Authorization: <span className="text-fg">{auth.status === "executed" && auth.outcome === "authorized" ? "authorized" : auth.status.replace(/_/g, " ")}</span>
            {auth.engine_label ? <span>, processed by {auth.engine_label}</span> : null}
            {auth.message ? <div className="text-[13px] text-status-warm">{auth.message}</div> : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {auth?.status === "pending" ? (
            <Link href="/feed" className="btn-primary">
              Open it in Needs you
            </Link>
          ) : null}
          {canAsk ? (
            <button type="button" className={auth?.status === "pending" ? "btn-secondary" : "btn-primary"} disabled={busy} onClick={() => act("request_authorization", { engine: view.consentAi ? engine : "none" }, "The authorization card is waiting in Needs you.")}>
              {auth?.status === "pending" ? "Refresh the card" : "Ask for authorization"}
            </button>
          ) : null}
        </div>
        {!canAsk && open && !(view.profile?.fields.length ?? 0) ? <div className="text-[12px] text-fg-dim">Add at least one fact to the discovery profile first.</div> : null}
      </section>
    </div>
  );
}
