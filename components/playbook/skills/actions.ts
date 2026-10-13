"use client";
/**
 * Skills tab actions (JARVIS plan 3): thin fetch helpers over the founder-only /api/skills routes
 * (same-origin, so the session cookie and the CSRF origin check both apply), and the 6-second
 * Undo queue. A queued edit is held in the browser; nothing is sent until the window closes,
 * a newer edit arrives, or the page is left (keepalive), whichever is first. Sent exactly once.
 */
import type { Op } from "@/lib/skills/contract";
import type { NewChange } from "@/lib/skills/view";

/**
 * Fix round 1 (task 9): carries the HTTP status and the server's error code alongside the raw
 * message, so a caller can map to a plain sentence (lib/skills/view.ts's `actionErrorMessage`)
 * instead of showing the server's own text - which is sometimes a snake_case code
 * ("not_held", "storage_not_ready") and sometimes contract/validation developer text
 * ("ops[0].label must be a kebab-case id"), neither fit for a user to read.
 */
export class ActionError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, info?: { status?: number; code?: string }) {
    super(message);
    this.status = info?.status;
    this.code = info?.code;
  }
}

async function post(url: string, body: unknown, keepalive = false): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive, credentials: "same-origin",
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    throw new ActionError(String(j.message ?? j.error ?? `the server answered ${r.status}`), {
      status: r.status, code: typeof j.error === "string" ? j.error : undefined,
    });
  }
  return j;
}

export const api = {
  queue: (change: NewChange, keepalive = false) => post("/api/skills/changes", change, keepalive),
  decide: (changeId: string, computerId: string, decision: "reject" | "accept-anyway") =>
    post(`/api/skills/changes/${encodeURIComponent(changeId)}/decision`, { computer_id: computerId, decision }),
  revise: (changeId: string, computerId: string, description: string, ops: Op[]) =>
    post(`/api/skills/changes/${encodeURIComponent(changeId)}/revise`, { computer_id: computerId, description, ops }),
  rebuild: (computerId: string) => post("/api/skills/rebuild", { computer_id: computerId }),
};

export type QueueState = { kind: "pending" | "sending" | "sent" | "undone" | "error"; description: string; message?: string };
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };

export function createPendingQueue(o: {
  send: (change: NewChange, keepalive: boolean) => Promise<void>;
  onState: (s: QueueState) => void;
  delayMs?: number;
  timers?: Timers;
}) {
  const timers: Timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  type Pending = { description: string; change: NewChange; handle: unknown };
  let current: Pending | null = null;

  /**
   * Codex fix round (P2, wrong data): every actual `o.send` call is chained through this promise,
   * so a later edit's send cannot begin until every earlier edit's send has SETTLED (resolved or
   * rejected) - never while one is still in flight. Before this chain existed, a second edit's
   * timer, a third edit arriving, or `flush()` could each call `fire()` and reach `o.send`
   * immediately, concurrently with an already-in-flight send; the server timestamps a change on
   * arrival and `pendingChanges()` applies that arrival order, so whichever request happened to
   * land on the wire last would win even though the user queued it first - an assign-then-remove
   * could be stored as remove-then-assign. `.catch(() => {})` on the wait means an earlier send's
   * FAILURE never blocks a later one from running (requirement (c): B still sends after A fails);
   * each fire's own try/catch below still reports that fire's own success or failure.
   */
  let sendChain: Promise<void> = Promise.resolve();

  /**
   * Ruling (fix round 1): every queued send carries `keepalive: true`, whatever triggered it -
   * the 6-second timer, an immediate send-the-old-one-now on a second edit, or the leaving-the-
   * page flush. A send that is NOT marked keepalive can be cancelled by the browser mid-flight if
   * the tab happens to be closing at that exact moment, and the edit is silently lost with no
   * toast - the same hazard flush exists to guard against, just reachable from a different
   * trigger. There is no call site left where `false` is actually safe.
   */
  const fire = async (opts?: { now?: boolean }) => {
    if (!current) return;
    const { description, change, handle } = current;
    current = null;
    timers.clear(handle);
    o.onState({ kind: "sending", description });
    let staleMessage: string | undefined;
    // Codex re-review (P2): `opts.now` (used only by `flush()` on page teardown, see its own
    // comment) skips waiting on `sendChain` and calls `o.send` immediately, synchronously within
    // this call - a deferred send queued behind an earlier one would never get the chance to
    // start once the document is destroyed, which is lost data, not merely out-of-order data.
    // Every other trigger (the timer, a second edit) still queues behind `previousChain` as
    // before. Either way, `sendChain` is advanced to wait for BOTH the previous chain and this
    // send, so a hypothetical later send still waits for everything already under way, even one
    // that skipped ahead of it.
    const previousChain = sendChain;
    const thisSend = opts?.now ? o.send(change, true) : previousChain.catch(() => {}).then(() => o.send(change, true));
    sendChain = Promise.allSettled([previousChain, thisSend]).then(() => undefined);
    try {
      await thisSend;
      o.onState({ kind: "sent", description });
    } catch (e) {
      staleMessage = (e as Error).message;
      o.onState({ kind: "error", description, message: staleMessage });
    }
    // Ruling C4: if a newer edit arrived while this one was in flight, `current` now points at
    // it. Re-announce ITS Undo toast (never leave "sent"/"error" for the OLD edit as the last
    // word on the newer one), carrying the stale failure text as `message` so the newer toast can
    // still say "Nothing changed" about the edit that just failed to send.
    // (The explicit cast widens `current` back to its declared union: TS narrows it to `null`
    // across this `await` because nothing inside THIS function's visible text reassigns it, even
    // though `add()` genuinely can while this send is in flight.)
    const pending = current as Pending | null;
    if (pending) {
      o.onState({ kind: "pending", description: pending.description, ...(staleMessage ? { message: staleMessage } : {}) });
    }
  };

  return {
    add(description: string, change: NewChange) {
      if (current) void fire();
      current = { description, change, handle: timers.set(() => void fire(), o.delayMs ?? 6000) };
      o.onState({ kind: "pending", description });
    },
    undo(): boolean {
      if (!current) return false;
      timers.clear(current.handle);
      const { description } = current;
      current = null;
      o.onState({ kind: "undone", description });
      return true;
    },
    /**
     * Codex re-review (P2, fixes a real data-loss bug in the first fix round): `flush()` fires on
     * `pagehide`, when there is no time left to wait. The first version of this fix made `flush()`
     * go through the SAME `sendChain` as every other trigger, reasoning that `keepalive: true`
     * would still get the send delivered - that reasoning was wrong. If an earlier send was still
     * in flight, the deferred send was queued behind a `.then()` callback waiting its turn; once
     * the document is destroyed, that callback never runs, so the edit never starts at all.
     * `keepalive` only protects a request that has already been handed to the network layer - it
     * cannot start one that is still waiting in a promise chain.
     *
     * The fix: `flush()` calls `fire({ now: true })`, which starts this send's `fetch` AT ONCE,
     * synchronously within the `pagehide` handler, even while an earlier edit's send is still in
     * flight. Nothing queued at teardown is ever lost. The accepted trade, and ONLY at teardown:
     * this send may reach the server out of order relative to one still in flight (the server
     * timestamps on arrival), where normal use (the 6s timer, a second edit) stays fully ordered
     * because the page is not disappearing out from under the chain. Plan 3 makes no server
     * change to close this; a later server-side ordered submission (e.g. a client sequence number
     * on each change, so the server can re-order instead of trusting arrival time) could.
     */
    flush() {
      void fire({ now: true });
    },
  };
}
