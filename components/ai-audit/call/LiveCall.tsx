"use client";

/**
 * The live-call screen: the discovery call, run from one page.
 *
 * Left, the questions in the handbook's order and words (lib/ai-audit/
 * framework.ts), each with why it is asked, its follow-ups, a notes box that
 * saves as CC types, and a box for each figure it answers. Right, the call's
 * clock, the client's consent, and what the audit still needs. On a phone it is
 * one column with the clock and "next question" pinned at the bottom.
 *
 * Keyboard: Alt+ArrowDown / Alt+ArrowUp move between questions.
 *
 * Nothing here talks to the client or to any AI service. Figures typed here are
 * saved to the discovery profile as Client-reported, from the call's notes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { QUESTION_CATEGORIES, QUESTION_CATEGORY_LABELS, essentialGaps, questionsFor, type DiscoveryQuestion } from "@/lib/ai-audit/framework";
import { PROFILE_FIELDS, type ProfileFieldDef } from "@/lib/ai-audit/profile";
import type { BusinessType } from "@/lib/ai-audit/rules";
import { describeError, postAction } from "@/components/ai-audit/workspace/api";
import { NumberInput } from "@/components/ai-audit/workspace/inputs";
import { createNoteSaver, type NoteAnswer, type NoteState } from "@/components/ai-audit/call/note-saver";

type Note = { question_id: string; notes: string; row_version: number };
type Field = { field_key: string; value: unknown; label: string };

type Props = {
  engagementId: string;
  businessType: BusinessType | null;
  callStartedAt: string | null;
  callEndedAt: string | null;
  notes: Note[];
  fields: Field[];
  editable: boolean;
};

const SAVE_AFTER_MS = 800;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const DEF_BY_KEY = new Map(PROFILE_FIELDS.map((d) => [d.key, d]));

/** One question's notes: local text, saved after a pause, compare-and-swap on the note's version. */
/** Sends one question's notes. keepalive lets the request outlive a page that is going away. */
async function sendNote(engagementId: string, questionId: string, notes: string, expectedVersion: number, opts: { keepalive: boolean; afterText: string | null }): Promise<NoteAnswer> {
  try {
    const res = await fetch(`/api/ai-audit/${encodeURIComponent(engagementId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_call_note", question_id: questionId, notes, expected_version: expectedVersion, ...(opts.afterText !== null ? { after_text: opts.afterText } : {}) }),
      keepalive: opts.keepalive,
    });
    const r = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; note?: Note; current?: Note } | null;
    if (r?.ok && r.note) return { kind: "saved", notes: r.note.notes, version: r.note.row_version };
    if (r?.error === "conflict" && r.current) return { kind: "conflict", notes: r.current.notes, version: r.current.row_version };
    if (r?.error === "stage_closed") return { kind: "closed" };
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

function NoteBox({ engagementId, q, initial, disabled }: { engagementId: string; q: DiscoveryQuestion; initial: Note | undefined; disabled: boolean }) {
  const [text, setText] = useState(initial?.notes ?? "");
  const [state, setState] = useState<NoteState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The text in the box right now, for saves that run after this render.
  const latest = useRef(text);
  // One save at a time, nothing typed lost, conflicts kept visible: components/ai-audit/call/note-saver.ts.
  const [saver] = useState(() =>
    createNoteSaver({
      text: initial?.notes ?? "",
      version: initial?.row_version ?? 0,
      read: () => latest.current,
      replace: (kept) => {
        latest.current = kept;
        setText(kept);
      },
      send: (notes, expectedVersion, opts) => sendNote(engagementId, q.id, notes, expectedVersion, opts),
      onState: setState,
    }),
  );

  // Leaving the screen (or the page) with typing not yet saved: save it now, not never (review of phase 2, F5).
  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void saver.flush();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [saver]);

  return (
    <div className="grid gap-1">
      <textarea
        className="textarea"
        style={{ minHeight: 72 }}
        disabled={disabled}
        aria-label={`Notes: ${q.ask}`}
        placeholder="What they said, in their words. Ranges are fine."
        value={text}
        onChange={(ev) => {
          latest.current = ev.target.value;
          setText(ev.target.value);
          saver.typed();
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void saver.save(), SAVE_AFTER_MS);
        }}
        onBlur={() => {
          // Typed and not saved yet (a save still out included): save now. After a conflict, only new typing overwrites.
          if (saver.wantsSave()) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            void saver.save();
          }
        }}
      />
      <div className="text-[11px] text-fg-dim" aria-live="polite">
        {state === "saving" ? "Saving" : state === "saved" ? "Saved" : state === "dirty" ? "Not saved yet" : state === "conflict" ? "Changed in another tab. Your text is kept here; keep typing to save it." : state === "closed" ? "Not saved: the call's information was authorized, so the notes are final." : state === "error" ? "Could not save. Keep typing to try again." : ""}
      </div>
    </div>
  );
}

/** A figure the question answers, saved to the profile as Client-reported from the call. */
function FigureBox({ engagementId, def, initial, disabled, onSaved }: { engagementId: string; def: ProfileFieldDef; initial: number | null; disabled: boolean; onSaved: (key: string) => void }) {
  const [value, setValue] = useState<number | null>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  // What the profile holds now: changing a figure and then changing it back must save both times.
  const saved = useRef<number | null>(initial);
  async function save(n: number | null) {
    if (n === null || n === saved.current) return;
    const r = await postAction(engagementId, "save_profile_field", {
      field: { field_key: def.key, value: n, label: "client_reported", source_type: "call_notes", source_note: "said on the discovery call" },
    });
    setMsg(r.ok ? "Saved to the profile" : describeError(r));
    if (r.ok) {
      saved.current = n;
      onSaved(def.key);
    }
  }
  return (
    <label className="grid gap-1">
      <span className="text-[12px] text-fg-muted">
        {def.label}
        {def.unit ? ` (${def.unit})` : def.type === "money" ? " ($)" : ""}
      </span>
      <div onBlur={() => void save(value)}>
        <NumberInput className="input w-40 tabular-nums" aria-label={def.label} disabled={disabled} value={value} onChange={setValue} />
      </div>
      {msg ? <span className="text-[11px] text-fg-dim">{msg}</span> : null}
    </label>
  );
}

export function LiveCall({ engagementId, businessType, callStartedAt, callEndedAt, notes, fields, editable }: Props) {
  const router = useRouter();
  const questions = useMemo(() => questionsFor(businessType), [businessType]);
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [captured, setCaptured] = useState(() => new Set(fields.map((f) => f.field_key)));
  const refs = useRef<Array<HTMLElement | null>>([]);
  const noteBy = useMemo(() => new Map(notes.map((n) => [n.question_id, n])), [notes]);
  const fieldBy = useMemo(() => new Map(fields.map((f) => [f.field_key, f])), [fields]);
  const running = !!callStartedAt && !callEndedAt;
  const gaps = essentialGaps(captured, businessType);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const go = useCallback(
    (i: number) => {
      const next = Math.max(0, Math.min(questions.length - 1, i));
      setActive(next);
      const el = refs.current[next];
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      el?.querySelector("textarea")?.focus({ preventScroll: true });
    },
    [questions.length],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.altKey) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        go(active + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        go(active - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, go]);

  async function act(action: "start_call" | "end_call") {
    setBusy(true);
    setMessage(null);
    const r = await postAction(engagementId, action);
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    router.refresh();
  }

  async function consent(key: "consent.recording" | "consent.ai_processing", yes: boolean) {
    setMessage(null);
    if (consentValue(key) === yes) return;
    const r = await postAction(engagementId, "save_profile_field", { field: { field_key: key, value: yes, label: "client_reported", source_type: "call_notes", source_note: "asked at the start of the call" } });
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    setCaptured((s) => new Set([...s, key]));
    router.refresh();
  }

  const consentValue = (key: string): boolean | null => {
    const f = fieldBy.get(key);
    return f && typeof f.value === "boolean" ? f.value : null;
  };
  const elapsed = callStartedAt ? (callEndedAt ? Date.parse(callEndedAt) : now) - Date.parse(callStartedAt) : 0;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      {/* The clock ticks, so the server's second and the browser's differ: expected, not a bug. */}
      <span className="tabular-nums text-sm text-fg" aria-label="Elapsed time" suppressHydrationWarning>
        {callStartedAt ? clock(elapsed) : "0:00"}
      </span>
      {editable && !running ? (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void act("start_call")}>
          {callStartedAt ? "Restart the clock" : "Start the call"}
        </button>
      ) : null}
      {editable && running ? (
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act("end_call")}>
          End the call
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="grid gap-5 pb-24 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:pb-0">
      <div className="grid content-start gap-4">
        {message ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg">{message}</div> : null}
        {!editable ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg-muted">The profile is authorized, so the call&apos;s notes are read-only now.</div> : null}
        {QUESTION_CATEGORIES.map((cat) => {
          const inCat = questions.filter((q) => q.category === cat);
          if (!inCat.length) return null;
          return (
            <section key={cat} className="grid gap-3">
              <h2 className="text-sm font-semibold text-fg">{QUESTION_CATEGORY_LABELS[cat]}</h2>
              {inCat.map((q) => {
                const i = questions.indexOf(q);
                const figures = q.fills.map((k) => DEF_BY_KEY.get(k)).filter((d): d is ProfileFieldDef => !!d && (d.type === "number" || d.type === "money"));
                const answered = q.fills.length > 0 && q.fills.every((k) => captured.has(k));
                return (
                  <article
                    key={q.id}
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    onFocus={() => setActive(i)}
                    className={`grid gap-2 rounded-xl border bg-bg-panel p-4 ${i === active ? "border-accent" : "border-hairline"}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-[15px] font-medium leading-6 text-fg">{q.ask}</p>
                      <span className={`shrink-0 text-[11px] ${q.essential ? "text-fg" : "text-fg-dim"}`}>
                        {q.essential ? "Essential" : "Optional"}
                        {answered ? ", answered" : ""}
                      </span>
                    </div>
                    <p className="text-[13px] text-fg-muted">{q.why}</p>
                    {q.follow_ups.length ? (
                      <ul className="grid gap-0.5 text-[13px] text-fg-muted">
                        {q.follow_ups.map((f) => (
                          <li key={f}>Follow up: {f}</li>
                        ))}
                      </ul>
                    ) : null}
                    {q.id === "open-consent" ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {(["consent.recording", "consent.ai_processing"] as const).map((key) => (
                          <div key={key} className="grid gap-1">
                            <span className="text-[12px] text-fg-muted">{key === "consent.recording" ? "Recording and transcription" : "AI analysis for the audit"}</span>
                            <div className="flex gap-2">
                              {[true, false].map((yes) => (
                                <button
                                  key={String(yes)}
                                  type="button"
                                  disabled={!editable}
                                  aria-pressed={consentValue(key) === yes}
                                  className={consentValue(key) === yes ? "btn-primary" : "btn-secondary"}
                                  onClick={() => void consent(key, yes)}
                                >
                                  {yes ? "Agreed" : "Declined"}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {figures.length ? (
                      <div className="flex flex-wrap gap-3">
                        {figures.map((d) => (
                          <FigureBox
                            key={d.key}
                            engagementId={engagementId}
                            def={d}
                            initial={typeof fieldBy.get(d.key)?.value === "number" ? (fieldBy.get(d.key)!.value as number) : null}
                            disabled={!editable}
                            onSaved={(key) => setCaptured((s) => new Set([...s, key]))}
                          />
                        ))}
                      </div>
                    ) : null}
                    <NoteBox engagementId={engagementId} q={q} initial={noteBy.get(q.id)} disabled={!editable} />
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>

      <aside className="grid content-start gap-4 lg:sticky lg:top-4 lg:self-start">
        <section className="hidden gap-3 rounded-xl border border-hairline bg-bg-panel p-4 lg:grid">
          <h2 className="text-sm font-semibold text-fg">The call</h2>
          {controls}
        </section>
        <section className="grid gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
          <h2 className="text-sm font-semibold text-fg">What the audit still needs</h2>
          {gaps.length ? (
            <>
              <div className="text-fg-muted">
                {gaps.length} essential answer{gaps.length === 1 ? "" : "s"} missing:
              </div>
              <ul className="grid gap-0.5">
                {gaps.map((k) => (
                  <li key={k} className="text-fg">
                    {DEF_BY_KEY.get(k)?.label ?? k}
                  </li>
                ))}
              </ul>
              <div className="text-[12px] text-fg-dim">Figures count once saved to the profile; the rest come from your notes and the transcript after the call.</div>
            </>
          ) : (
            <div className="text-fg">Every essential answer is in the profile.</div>
          )}
        </section>
        <section className="grid gap-1 rounded-xl border border-hairline bg-bg-panel p-4 text-[13px] text-fg-muted">
          <h2 className="text-sm font-semibold text-fg">Remember</h2>
          <p>No prices on this call. No promised results. No statistics you cannot source.</p>
          <p>If they start reading out a password or a login, stop them: access is set up later through Connections.</p>
          <Link href="/playbook/ai-audit-discovery-handbook" className="underline">
            Discovery Call Handbook
          </Link>
          <Link href={`/ai-audit/${engagementId}`} className="underline">
            Back to the engagement
          </Link>
        </section>
      </aside>

      {/* Phone: the clock and the next question, pinned at the bottom. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 border-t border-hairline bg-bg-panel px-4 py-3 lg:hidden">
        {controls}
        <button type="button" className="btn-secondary" onClick={() => go(active + 1)} disabled={active >= questions.length - 1}>
          Next question
        </button>
      </div>
    </div>
  );
}
