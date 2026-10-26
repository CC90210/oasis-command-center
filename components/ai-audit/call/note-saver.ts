/**
 * How the live-call screen saves one question's notes, kept apart from React so
 * its timing can be tested (tests/ai-audit-rules.test.ts).
 *
 * One save at a time. A second save sent while the first is still out carries
 * the old version, so the server refuses it as a conflict and the newer text is
 * lost (review of phase 2: type, pause, type more, tab away, and the second
 * half was gone). Anything typed during a save is saved the moment it returns.
 *
 * After a conflict (another tab saved first) the text typed here stays in the
 * box, and only new typing writes over the other tab's text. A "conflict" whose
 * text is exactly what the box holds is no conflict: nothing is lost.
 *
 * Leaving the screen or the page sends what is unsaved with keepalive, so the
 * request outlives the page. With a save still out it names that save's text
 * (afterText): the server takes the closing save on top of it whichever of the
 * two arrives first (lib/ai-audit/call-notes.ts).
 *
 * The server scrubs a possible password out of a note (as from a transcript);
 * the box then shows what was kept, unless CC typed on in the meantime.
 */

export type NoteState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "closed" | "error";

/**
 * The server's answer: saved (the note as it now is), a conflict (the note as
 * the other tab left it), closed (the information was authorized at Gate 1, so
 * notes no longer change), or a failure.
 */
export type NoteAnswer =
  | { kind: "saved"; notes: string; version: number }
  | { kind: "conflict"; notes: string; version: number }
  | { kind: "closed" }
  | { kind: "failed" };

export type NoteSend = (notes: string, expectedVersion: number, opts: { keepalive: boolean; afterText: string | null }) => Promise<NoteAnswer>;

export type NoteSaver = {
  /** CC typed: the box now differs from what is saved. */
  typed(): void;
  /** Save what is in the box now, or right after the save that is out. */
  save(): Promise<void>;
  /** Whether leaving the box should save: typed and not saved yet, and not sitting on a conflict. */
  wantsSave(): boolean;
  /** Leaving the screen or the page: send what is unsaved now, with keepalive. */
  flush(): Promise<void>;
  state(): NoteState;
};

export function createNoteSaver(o: {
  /** The note as the page loaded it (empty text and version 0 when there is none yet). */
  text: string;
  version: number;
  /** The text in the box right now. */
  read: () => string;
  /** Put this text in the box (the server's scrubbed copy of what was sent). */
  replace?: (text: string) => void;
  send: NoteSend;
  onState: (s: NoteState) => void;
}): NoteSaver {
  let version = o.version;
  let saved = o.text;
  let state: NoteState = "idle";
  let inFlight = false;
  let again = false;
  /** The text of the save that is out, for a closing save to name. */
  let sending: string | null = null;

  const set = (s: NoteState) => {
    state = s;
    o.onState(s);
  };
  // Every answer that carries the note moves what we know forward, never back:
  // two requests out at once (a flush beside the save loop) may answer in either order.
  const learn = (a: NoteAnswer) => {
    if ((a.kind === "saved" || a.kind === "conflict") && a.version > version) {
      version = a.version;
      saved = a.notes;
    }
  };
  // A save that is out is not saved until it answers: if the page goes now, its
  // request may be cancelled with it, so a closing flush sends the box again with
  // keepalive, naming the save that is out (Codex review of phase 2, fourth pass).
  // That covers typing the old text back while a draft is out, too (first pass).
  const unsaved = () => {
    if (state === "conflict" || state === "closed") return false;
    if (inFlight && sending !== null) return true;
    return o.read() !== saved;
  };

  async function run(keepalive: boolean): Promise<void> {
    inFlight = true;
    try {
      do {
        again = false;
        const t = o.read();
        if (t === saved) {
          set("saved");
          break;
        }
        set("saving");
        sending = t;
        const a = await o.send(t, version, { keepalive, afterText: null });
        sending = null;
        learn(a);
        // A closing flush found another tab's edit meanwhile: stop here, never send over it.
        if (state === "conflict" || state === "closed") break;
        if (a.kind === "saved") {
          if (a.notes !== t && o.read() === t && o.replace) o.replace(a.notes);
          set(o.read() === saved ? "saved" : "dirty");
          continue;
        }
        if (a.kind === "conflict") {
          set(a.notes === o.read() ? "saved" : "conflict");
          break;
        }
        set(a.kind === "closed" ? "closed" : "error");
        break;
      } while (again);
    } finally {
      inFlight = false;
      sending = null;
    }
  }

  return {
    typed() {
      if (state === "closed") return;
      set("dirty");
    },
    async save() {
      if (state === "conflict" || state === "closed") return;
      if (inFlight) {
        again = true;
        return;
      }
      await run(false);
    },
    wantsSave: unsaved,
    async flush() {
      if (!unsaved()) return;
      if (!inFlight) {
        await run(true);
        return;
      }
      // A save is out. The loop sends this text when it returns, if the page is
      // still here. In case it is not, send it now too, naming the save that is
      // out: the server puts this one on top of it in either order.
      again = true;
      const a = await o.send(o.read(), version, { keepalive: true, afterText: sending });
      learn(a);
      // Another tab changed the note: keep the conflict, and stop the save queued behind
      // this one, or it would send the box again over the other tab's words (Codex review, fifth pass).
      if (a.kind === "conflict" && a.notes !== o.read()) {
        again = false;
        set("conflict");
      } else if (a.kind === "closed") {
        again = false;
        set("closed");
      }
    },
    state: () => state,
  };
}

/**
 * A figure box: one save at a time, and the LAST value CC entered is the one
 * the profile ends with, whatever order the answers come back in (Codex review
 * of phase 2: enter 20, put 10 back before the first save answered, and the
 * profile kept 20 while the box showed 10). Clearing the box removes the figure.
 */
export type FigureSend<T = number> = (value: T | null) => Promise<{ ok: true } | { ok: false; message: string }>;

/**
 * One stored value (a figure, or a consent answer): one save at a time, and the
 * last value asked for wins, so a quick correction is never dropped behind a
 * save still in flight (Codex review of phase 2).
 */
export function createFigureSaver<T = number>(o: {
  initial: T | null;
  send: FigureSend<T>;
  onResult: (r: { ok: true; value: T | null } | { ok: false; message: string }) => void;
}): { set(value: T | null): Promise<void>; saved(): T | null } {
  let saved = o.initial;
  let wanted = o.initial;
  let inFlight = false;
  return {
    async set(value) {
      wanted = value;
      if (inFlight) return;
      inFlight = true;
      try {
        while (wanted !== saved) {
          const v = wanted;
          const r = await o.send(v);
          if (!r.ok) {
            o.onResult(r);
            return;
          }
          saved = v;
          if (wanted === saved) o.onResult({ ok: true, value: v });
        }
      } finally {
        inFlight = false;
      }
    },
    saved: () => saved,
  };
}
