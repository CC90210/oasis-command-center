/**
 * lib/bridge/harness-jobs/disconnect-hold.ts - cancel a coding task when the
 * person who asked for it leaves, on a platform that has already stopped the
 * request by then.
 *
 * WHY (2026-10-20 audit; workerd probe). On Cloudflare Workers (how this app
 * runs, via OpenNext) a closed tab never fires request.signal's abort. The
 * signal that does arrive is the response stream's cancel(), and the runtime
 * calls it after it has dropped the request's context: getCloudflareContext()
 * is not visible there, and I/O started there, behind the two pipeThrough
 * stages the reply passes through, was cut off, with or without keepAlive. So
 * `await cancelHarnessJob(...)` inside cancel() never reached the database and
 * the task kept running on the person's computer, acting, after they had gone.
 *
 * What survives is work chained from a promise that was created while the
 * request was alive and handed to ctx.waitUntil then. This is that promise:
 *
 *   - createDisconnectHold() runs at request time and hands the hold to the
 *     platform (keepAlive). The cancel is not started yet.
 *   - run(cancel) is called from whatever notices the person leaving: the
 *     stream's cancel(), or the route's abort listener where the runtime fires
 *     one. The first call starts the cancel FROM the held promise, which
 *     settles when the cancel has, so the platform keeps the Worker alive for
 *     exactly that long. Any later call starts nothing and waits for the same
 *     cancel: one job, one cancel, however many triggers fire.
 *   - release() is the normal end of a turn. Nothing is left to cancel, so the
 *     hold settles at once. Without it the request would sit on a pending
 *     waitUntil for the whole ~30 s grace period after every reply.
 *
 * A promise settles once, so whichever of run() and release() comes first
 * decides, and the other is a no-op. Neither throws; a failed cancel is logged.
 */
import "server-only";
import { keepAlive } from "@/lib/os/runs/keepalive";

export type DisconnectHold = {
  /**
   * Cancel now. The first call, from any trigger, runs `cancel`; later calls
   * run nothing and return the same outcome. Resolves when that cancel has
   * finished, and never rejects.
   */
  run(cancel: () => Promise<unknown>): Promise<void>;
  /** The turn ended on its own, so there is nothing to cancel: free the platform hold. */
  release(): void;
};

type Cancel = () => Promise<unknown>;

export function createDisconnectHold(label: string): DisconnectHold {
  let decide!: (cancel: Cancel | null) => void;
  const decision = new Promise<Cancel | null>((resolve) => {
    decide = resolve;
  });
  // Every step hangs off `decision`, which exists NOW, while the request does.
  const held: Promise<void> = decision
    .then((cancel) => (cancel ? cancel() : undefined))
    .then(
      () => undefined,
      (error: unknown) => {
        console.error("[bridge.harness.disconnect-cancel]", {
          label,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      },
    );
  void keepAlive(held, label);
  return {
    run(cancel) {
      decide(cancel);
      return held;
    },
    release() {
      decide(null);
    },
  };
}
