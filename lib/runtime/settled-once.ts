/**
 * A value computed once per Worker isolate and shared across requests ONLY
 * after it has settled.
 *
 * One Cloudflare Worker isolate serves many requests at once, and module-level
 * state is shared by all of them. A module-level promise that is still PENDING
 * is the trap. Request A starts the read; request B awaits A's promise; the
 * runtime ties that read to request A. If A finishes or is aborted first (a fast
 * click aborts the previous navigation), the runtime cancels B's continuation
 * and then kills B as hung: "The Workers runtime canceled this request because
 * it detected that your Worker's code had hung". The promise also never
 * settles, so every later request in that isolate waits on it as well.
 *
 * Production evidence, 2026-10-01 (the pipeline incident): the runtime logged
 * "A promise was resolved or rejected from a different request context than
 * the one it was created in" at the same seconds as the hung /pipeline, /,
 * /team/*, /money and /agents navigations that showed "Something went wrong".
 *
 * settledOnce(load) keeps only a SETTLED value at module scope. Until one
 * exists, each caller runs `load` itself, so a request only ever awaits its own
 * I/O. To share one in-flight load within a single request, pass a load wrapped
 * in React's cache(): React scopes that cache to the request, never the isolate.
 *
 * tests/worker-request-isolation.test.ts pins this, and fails on any server
 * module that keeps a pending promise at module scope.
 */
export type SettledOnce<T> = {
  /** The settled value, or this caller's own load. */
  get(): Promise<T>;
  /** Forget the settled value. A load already in flight cannot restore it. */
  reset(): void;
};

export function settledOnce<T>(load: () => Promise<T>): SettledOnce<T> {
  let settled = false;
  let value: T | undefined;
  let generation = 0;
  return {
    async get(): Promise<T> {
      if (settled) return value as T;
      const startedIn = generation;
      // A failure throws from here and is not remembered: the next call loads again.
      const loaded = await load();
      if (startedIn === generation) {
        value = loaded;
        settled = true;
      }
      return loaded;
    },
    reset(): void {
      generation += 1;
      settled = false;
      value = undefined;
    },
  };
}
