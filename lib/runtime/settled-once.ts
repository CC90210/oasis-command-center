/**
 * A value computed once per Worker isolate and shared across requests ONLY
 * after it has settled.
 *
 * One Cloudflare Worker isolate serves many requests at once, and module-level
 * state is shared by all of them. A module-level promise that is still PENDING
 * is a trap. Request A starts the read and request B awaits A's promise; the
 * read's I/O belongs to request A. That holds only while A stays alive: if A is
 * canceled before the read settles, the promise never settles, and every later
 * request in that isolate waits on it until the isolate is recycled. When a
 * promise is SETTLED from another request's continuation after its own request
 * was canceled, the runtime logs "A promise was resolved or rejected from a
 * different request context than the one it was created in" and kills the
 * waiter: "The Workers runtime canceled this request because it detected that
 * your Worker's code had hung".
 *
 * The 2026-10-01 pipeline incident logged exactly those two lines on the hung
 * /pipeline, /, /team/*, /money and /agents navigations. The cause proven in
 * the runtime was the shared libSQL statement queue (lib/turso.ts
 * LIBSQL_CLIENT_OPTIONS: 10 of 12 requests killed before, 0 after); the finance
 * memos that used this helper's predecessor were the same shape, a latent risk.
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
