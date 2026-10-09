/**
 * lib/offer-pages/save-queue.ts - one draft save at a time, newest wins.
 *
 * WHY. A draft save is a compare-and-swap on the version the previous save
 * returned (app/api/forms/[id]/offer PUT). Two saves in flight carry the same
 * version, so the second reads as someone else's edit (draft_conflict) and the
 * builder stops saving for the rest of the visit: a save slower than the
 * autosave delay (a cold isolate, a phone on 4G) plus one more keystroke, or a
 * claim ticked mid-save, was enough (CodeRabbit on #557). Here a save waits
 * for the one in flight; while it waits only the newest value is kept, and it
 * is sent once the first save has moved the version on.
 *
 * Pure, and per builder instance (never module scope), so the test drives it
 * with promises it controls.
 */
export type SerialSaver<T> = {
  /** Save `value` after any save in flight. Resolves once it, or a newer value, is saved. */
  save(value: T): Promise<void>;
  /** Resolves when no save is in flight (at once when none is). */
  idle(): Promise<void>;
};

export function serialSaver<T>(saveOnce: (value: T) => Promise<void>): SerialSaver<T> {
  let queued: { value: T } | null = null;
  let running: Promise<void> | null = null;
  return {
    save(value: T): Promise<void> {
      queued = { value };
      if (running) return running;
      running = (async () => {
        try {
          while (queued) {
            const next = queued.value;
            queued = null;
            await saveOnce(next);
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
    idle(): Promise<void> {
      return running ?? Promise.resolve();
    },
  };
}
