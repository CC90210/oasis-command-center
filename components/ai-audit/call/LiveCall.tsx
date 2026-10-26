"use client";

/**
 * The live-call screen: the discovery call, run from one page.
 *
 * Left, the questions in the handbook's order and words (lib/ai-audit/
 * framework.ts), each with why it is asked, its follow-ups, a notes box that
 * saves as CC types, and a box for each figure it answers. Right, the call's
 * clock, the call room, and what the audit still needs. On a phone it is one
 * column, the call room above the questions, with the clock and "next
 * question" pinned at the bottom.
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
import { createFigureSaver, createNoteSaver, type NoteAnswer, type NoteState } from "@/components/ai-audit/call/note-saver";

type Note = { question_id: string; notes: string; row_version: number };
type Field = { field_key: string; value: unknown; label: string };

/** What the live-call screen shows from the pre-call brief (lib/ai-audit/brief.ts). */
export type CallBrief = {
  hypotheses: Array<{ id: string; statement: string; test: string; questions: string[] }>;
  confirm: Array<{ statement: string; question_id: string }>;
  weight: Array<{ question_id: string; why: string }>;
};

/** The lead's Oasis Meet room for the call (lib/ai-audit/meet-link.ts), if there is one. */
export type CallRoom = {
  code: string;
  title: string;
  status: string;
  recordAudio: boolean;
  guests: Array<{ name: string; consented: boolean; removed: boolean }>;
  /** Meet's transcript status (queued, transcribing, ready, expired, deleted, lost), or null before it has one. */
  transcript: string | null;
  /** Its transcript is on this engagement. */
  attached: boolean;
  /** Why the tick leaves its ready transcript for the owner's hand (meet-link.ts AuditRoom.holds). */
  holds: string[];
};

const JOINS_BY_ITSELF =
  "It joins this engagement by itself when Meet has the transcript ready, if every guest agreed to the recording on joining and the workspace owner recorded the client's answer about AI analysis above. Otherwise it waits under Call and transcripts for the owner to attach.";

/** What the call room box says about the room: only what will really happen to its transcript. */
function roomWords(room: CallRoom, editable: boolean): string {
  const state = room.status === "live" ? "Live now." : room.status === "ended" ? "Ended." : "Not started yet.";
  if (room.attached) return `${state} Its transcript is on this engagement.`;
  if (!editable) return `${state} The profile is authorized, so no transcript can join this engagement now.`;
  if (!room.recordAudio) return `${state} Not recorded: paste the transcript after the call.`;
  if (room.status !== "ended") return `${state} Recorded and transcribed. ${JOINS_BY_ITSELF}`;
  if (room.transcript === "ready") {
    if (!room.guests.length) return `${state} No guest joined, so its transcript is not the client's call.`;
    if (room.guests.some((g) => !g.consented)) return `${state} A guest did not agree to the recording, so its transcript cannot be used.`;
    if (room.holds.length) return `${state} Its transcript waits for the workspace owner to attach it under Call and transcripts: ${room.holds.join("; ")}.`;
    return `${state} Its transcript is ready. It joins this engagement once the workspace owner has recorded the client's answer about AI analysis above, or the owner attaches it under Call and transcripts.`;
  }
  if (room.transcript === "expired" || room.transcript === "deleted" || room.transcript === "lost") return `${state} Meet has no transcript of it: paste one, or work from your notes.`;
  return `${state} Meet is still making its transcript. ${JOINS_BY_ITSELF}`;
}

type Props = {
  brief: CallBrief | null;
  room: CallRoom | null;
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
function FigureBox({ engagementId, def, initial, disabled, onSaved }: { engagementId: string; def: ProfileFieldDef; initial: number | null; disabled: boolean; onSaved: (key: string, present: boolean) => void }) {
  const [value, setValue] = useState<number | null>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  // One save at a time; the last figure entered wins; clearing removes it (components/ai-audit/call/note-saver.ts).
  const [saver] = useState(() =>
    createFigureSaver({
      initial,
      send: async (v) => {
        const r =
          v === null
            ? await postAction(engagementId, "delete_profile_field", { field_key: def.key })
            : await postAction(engagementId, "save_profile_field", {
                field: { field_key: def.key, value: v, label: "client_reported", source_type: "call_notes", source_note: "said on the discovery call" },
              });
        return r.ok ? { ok: true as const } : { ok: false as const, message: describeError(r) };
      },
      onResult: (r) => {
        setMsg(r.ok ? (r.value === null ? "Removed from the profile" : "Saved to the profile") : r.message);
        if (r.ok) onSaved(def.key, r.value !== null);
      },
    }),
  );
  const save = (n: number | null) => saver.set(n);
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

type ConsentKey = "consent.recording" | "consent.ai_processing";

/**
 * One consent answer from the opening. It keeps its own choice and saves through
 * the figure saver: one save at a time, the last choice wins. Comparing with the
 * page's props instead dropped a quick correction, Agreed then Declined, while
 * the first save was still out (Codex review of phase 2, second pass).
 */
function ConsentChoice({ engagementId, fieldKey, label, initial, disabled, onSaved }: { engagementId: string; fieldKey: ConsentKey; label: string; initial: boolean | null; disabled: boolean; onSaved: (key: ConsentKey) => void }) {
  const [chosen, setChosen] = useState<boolean | null>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const stored = useRef<boolean | null>(initial);
  const [saver] = useState(() =>
    createFigureSaver<boolean>({
      initial,
      send: async (v) => {
        if (v === null) return { ok: true as const };
        const r = await postAction(engagementId, "save_profile_field", {
          field: { field_key: fieldKey, value: v, label: "client_reported", source_type: "call_notes", source_note: "asked at the start of the call" },
        });
        if (!r.ok) return { ok: false as const, message: describeError(r) };
        stored.current = v;
        return { ok: true as const };
      },
      onResult: (r) => {
        if (r.ok) {
          setMsg(null);
          onSaved(fieldKey);
        } else {
          // Show what is stored, not the choice that failed to save.
          setChosen(stored.current);
          setMsg(r.message);
        }
      },
    }),
  );
  return (
    <div className="grid gap-1">
      <span className="text-[12px] text-fg-muted">{label}</span>
      <div className="flex gap-2">
        {[true, false].map((yes) => (
          <button
            key={String(yes)}
            type="button"
            disabled={disabled}
            aria-pressed={chosen === yes}
            className={chosen === yes ? "btn-primary" : "btn-secondary"}
            onClick={() => {
              setChosen(yes);
              void saver.set(yes);
            }}
          >
            {yes ? "Agreed" : "Declined"}
          </button>
        ))}
      </div>
      {msg ? <span className="text-[11px] text-fg-dim">{msg}</span> : null}
    </div>
  );
}

export function LiveCall({ brief, room, engagementId, businessType, callStartedAt, callEndedAt, notes, fields, editable }: Props) {
  const weighted = useMemo(() => new Map((brief?.weight ?? []).map((w) => [w.question_id, w.why])), [brief]);
  const toConfirm = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of brief?.confirm ?? []) m.set(c.question_id, [...(m.get(c.question_id) ?? []), c.statement]);
    return m;
  }, [brief]);
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

  async function makeRoom() {
    setBusy(true);
    setMessage(null);
    const r = await postAction(engagementId, "create_meet_room");
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    router.refresh();
  }

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

  // Shown twice, like the clock: above the questions on a phone (where the side column comes after all of them),
  // in the side column on a wide screen. `visibility` picks which.
  const callRoomBox = (visibility: string) => (
    <section className={`${visibility} gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm`}>
      <h2 className="text-sm font-semibold text-fg">Call room</h2>
      {room ? (
        <>
          <a className="btn-secondary justify-self-start" href={`/meet/${room.code}`} target="_blank" rel="noopener noreferrer">
            Open {room.title}
          </a>
          <div className="text-[12px] text-fg-muted">{roomWords(room, editable)}</div>
          {room.guests.length ? (
            <ul className="grid gap-0.5 text-[12px]">
              {room.guests.map((g, i) => (
                <li key={`${g.name}-${i}`} className={g.consented && !g.removed ? "text-fg-muted" : "text-status-warm"}>
                  {g.name}: {g.consented ? "agreed to the recording" : "did not agree to the recording"}
                  {g.removed ? ", removed from the call" : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {/* The only room has ended: another call needs another room. */}
          {editable && room.status === "ended" ? (
            <button type="button" className="btn-secondary justify-self-start" disabled={busy} onClick={() => void makeRoom()}>
              Make another call room
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="text-[12px] text-fg-muted">No Oasis Meet room for this lead yet. One is made when the call is booked, or here.</div>
          {editable ? (
            <button type="button" className="btn-secondary justify-self-start" disabled={busy} onClick={() => void makeRoom()}>
              Make a call room
            </button>
          ) : null}
        </>
      )}
    </section>
  );

  return (
    <div className="grid gap-5 pb-24 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:pb-0">
      <div className="grid content-start gap-4">
        {message ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg">{message}</div> : null}
        {!editable ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg-muted">The profile is authorized, so the call&apos;s notes are read-only now.</div> : null}
        {callRoomBox("grid lg:hidden")}
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
                    {weighted.has(q.id) ? (
                      <div className="text-[12px] font-medium text-accent">Spend time here: {weighted.get(q.id)}</div>
                    ) : null}
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-[15px] font-medium leading-6 text-fg">{q.ask}</p>
                      <span className={`shrink-0 text-[11px] ${q.essential ? "text-fg" : "text-fg-dim"}`}>
                        {q.essential ? "Essential" : "Optional"}
                        {answered ? ", answered" : ""}
                      </span>
                    </div>
                    {toConfirm.has(q.id) ? (
                      <div className="text-[12px] text-fg-muted">
                        On the form they said: {toConfirm.get(q.id)!.join("; ")}. Confirm it in their words.
                      </div>
                    ) : null}
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
                          <ConsentChoice
                            key={key}
                            engagementId={engagementId}
                            fieldKey={key}
                            label={key === "consent.recording" ? "Recording and transcription" : "AI analysis for the audit"}
                            initial={consentValue(key)}
                            disabled={!editable}
                            onSaved={(k) => {
                              setCaptured((s) => new Set([...s, k]));
                              router.refresh();
                            }}
                          />
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
                            onSaved={(key, present) =>
                              setCaptured((s) => {
                                const next = new Set(s);
                                if (present) next.add(key);
                                else next.delete(key);
                                return next;
                              })
                            }
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
        {callRoomBox("hidden lg:grid")}
        {brief && brief.hypotheses.length ? (
          <section className="grid gap-2 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
            <h2 className="text-sm font-semibold text-fg">From the pre-call brief</h2>
            <p className="text-[12px] text-fg-muted">Likely problems, not facts: test them in the client&apos;s own words.</p>
            <ul className="grid gap-2">
              {brief.hypotheses.map((h) => (
                <li key={h.id} className="grid gap-0.5">
                  <span className="text-fg">{h.statement}</span>
                  <span className="text-[12px] text-fg-muted">Test it: {h.test}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
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
