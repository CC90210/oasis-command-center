/**
 * lib/os/read-limiter.ts - at most N reads at once for one load, and a load
 * that can be stopped.
 *
 * WHY (2026-10-02). The libSQL client's own queue is unbounded on purpose
 * (LIBSQL_CLIENT_OPTIONS, lib/turso.ts: twenty statements in flight once hung
 * the Worker), so a load that fans its reads out in chunks bounds itself
 * here. Once the load has answered, or one of its reads has failed (which
 * fails the whole load), it is cancelled and nothing more starts: reads
 * waiting for a slot are dropped at once and new ones are refused, so a slow
 * database is not handed more work for an answer nobody is waiting for.
 *
 * Leaf module (no imports), like lib/os/deadline.ts, so a loader and its
 * tests (tests/read-limiter.test.ts) can use it without a database or a
 * session. Make one limiter per load, never at module scope: nothing pending
 * may be shared across requests on Workers
 * (tests/worker-request-isolation.test.ts).
 */

/** Runs a task when one of the load's read slots is free. */
export type Limiter = <T>(task: () => PromiseLike<T>) => Promise<T>;

/**
 * What a cancelled load's dropped reads throw. Each cancel makes its own, and
 * a cancel is recognised by identity (isLoadCancelled), so an AbortError from
 * anywhere else is never mistaken for it and is treated as the failure it is.
 */
export class LoadCancelled extends Error {
  constructor() {
    super("The load had already answered; this read was not started.");
    this.name = "LoadCancelled";
  }
}

/** Stops a load: every read it has not started yet is dropped. */
export function cancelLoad(cancel: AbortController): void {
  if (!cancel.signal.aborted) cancel.abort(new LoadCancelled());
}

/** True only for this load's own cancel (its signal's reason), never for another AbortError. */
export function isLoadCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason;
}

/**
 * At most `max` tasks at once, for one load. Once the load is cancelled no
 * task starts: the ones waiting for a slot are dropped and new ones refused.
 * A failed task cancels the load BEFORE it gives up its slot, so the slot is
 * never handed to a read whose answer nobody will use.
 */
export function createLimiter(max: number, cancel: AbortController): Limiter {
  const signal = cancel.signal;
  let active = 0;
  // A finishing task hands its slot straight to the next one waiting (true),
  // so a slot is never counted twice; the cancel wakes every waiter without
  // one (false).
  const waiting: Array<(slot: boolean) => void> = [];
  signal.addEventListener("abort", () => {
    for (const wake of waiting.splice(0)) wake(false);
  }, { once: true });
  const release = () => {
    const next = waiting.shift();
    if (next) next(true);
    else active -= 1;
  };
  return async <T>(task: () => PromiseLike<T>): Promise<T> => {
    signal.throwIfAborted();
    if (active < max) {
      active += 1;
    } else {
      const slot = await new Promise<boolean>((resolve) => waiting.push(resolve));
      if (signal.aborted) {
        if (slot) release();
        signal.throwIfAborted();
      }
    }
    try {
      return await task();
    } catch (error) {
      if (!isLoadCancelled(error, signal)) cancelLoad(cancel);
      throw error;
    } finally {
      release();
    }
  };
}
