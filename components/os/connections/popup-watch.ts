/**
 * popup-watch — the Connections hub's watch on a connect popup: the callback
 * page's postMessage, or the popup being closed. The window and the timers are
 * passed in, so tests/os-connectors.test.ts drives it in bare node.
 *
 * It returns a stop function. The hub calls it when it unmounts and before it
 * starts another popup, so the message listener and the poll never outlive the
 * page that started them, and `onDone` (router.refresh and state updates) never
 * runs after the hub is gone (CodeRabbit, PR #468).
 */

export type PopupResult = { status?: string; reason?: string };

export type PopupWatchEnv = {
  /** The page's own origin: a message from anywhere else is ignored. */
  origin: string;
  addMessageListener: (fn: (e: MessageEvent) => void) => void;
  removeMessageListener: (fn: (e: MessageEvent) => void) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/** How often the hub checks whether the user closed the popup by hand. */
export const POPUP_POLL_MS = 800;

/**
 * Watch one popup until it reports back or closes, then call `onDone` once.
 * The returned stop function removes the listener and the poll; after it,
 * `onDone` is never called. Calling it twice is harmless.
 */
export function watchPopup(args: {
  popup: { readonly closed: boolean };
  /** The `source` the callback page posts, e.g. "constant_contact". */
  source: string;
  env: PopupWatchEnv;
  onDone: (result: PopupResult) => void;
}): () => void {
  const { popup, source, env, onDone } = args;
  let stopped = false;
  let poll: unknown = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    env.removeMessageListener(onMessage);
    env.clearInterval(poll);
  };
  const finish = (result: PopupResult) => {
    if (stopped) return;
    stop();
    onDone(result);
  };
  function onMessage(e: MessageEvent) {
    if (e.origin !== env.origin) return;
    // Only the popup this watch opened may finish it: another same-origin
    // window (a second connect attempt, a stale tab) posting the same connector
    // source must not close this popup or report its result (CodeRabbit #469).
    if (e.source !== (popup as unknown as MessageEventSource)) return;
    const d = e.data as { source?: string; status?: string; reason?: string } | null;
    if (!d || d.source !== source) return;
    finish({ status: d.status, reason: d.reason });
  }

  env.addMessageListener(onMessage);
  poll = env.setInterval(() => {
    // Closed with no message: it may still have finished, so the hub re-reads.
    if (popup.closed) finish({});
  }, POPUP_POLL_MS);
  return stop;
}
