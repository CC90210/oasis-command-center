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
   * Codex re-review round 2 (P2 + controller finding): every edit that `fire()` has captured from
   * `current` but whose real `o.send` has not yet actually been invoked, in the order captured. An
   * entry removes itself the moment its send starts - via its own place in `sendChain` (the normal
   * case) OR via a forced start at page teardown, whichever happens FIRST - so a send is invoked
   * EXACTLY ONCE even when both paths race for the same entry (a duplicate POST would create a
   * duplicate change). This list exists because teardown needs to reach edits that `fire()` has
   * already taken off `current` but has not yet started - the earlier fix only forced the
   * still-pending `current` edit, so a second queued-but-not-yet-sent edit (B's own timer fired
   * while A was in flight, or a third edit arriving) was still silently lost at teardown.
   */
  type Unstarted = { start: () => Promise<void> };
  let unstarted: Unstarted[] = [];

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
    // Codex re-review round 2: a ONE-SHOT starter for this edit's real send. Whichever path
    // reaches it FIRST - its own place in `sendChain` below (the normal case), or a forced
    // immediate start at page teardown (`opts.now`, or `flush({ teardown: true })` reaching back
    // into `unstarted` for an edit `fire()` already took earlier) - actually calls `o.send`; the
    // other becomes a no-op that reuses the same promise, so the POST never goes out twice.
    let startedPromise: Promise<void> | null = null;
    const entry: Unstarted = {
      start: () => {
        if (!startedPromise) {
          unstarted = unstarted.filter((e) => e !== entry);
          startedPromise = o.send(change, true);
        }
        return startedPromise;
      },
    };
    unstarted.push(entry);
    // `previousChain` is captured before `sendChain` is reassigned, so a later edit's own place
    // in the chain still waits for EVERYTHING already under way, including an entry that skipped
    // ahead via a forced start - `allSettled` covers both the previous chain and this send.
    const previousChain = sendChain;
    const thisSend = previousChain.catch(() => {}).then(() => entry.start());
    sendChain = Promise.allSettled([previousChain, thisSend]).then(() => undefined);
    // `opts.now` (used only by `flush()`, see its own comment) forces this edit's send to start
    // AT ONCE, synchronously, right here - bypassing the wait on `previousChain` - instead of
    // only queuing it behind the chain. A deferred send queued behind an earlier one would never
    // get the chance to start once the document is destroyed, which is lost data, not merely
    // out-of-order data.
    if (opts?.now) entry.start();
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
     * Codex re-review round 2 (P2 + controller finding, fixes two real bugs in the prior round):
     *
     * (1) The first fix made EVERY `flush()` call - including the ones `SkillsTab.tsx` makes from
     * a plain effect cleanup (component unmount, client-side navigation, the per-computer
     * remount) - start its send at once. None of those destroy the JS context, so that reopened
     * the original out-of-order bug for completely ordinary in-app use: an assign could be forced
     * ahead of an in-flight unassign just because the user navigated to another tab. Only the
     * true page-teardown signal (`pagehide`) may skip the chain; every other `flush()` call now
     * goes through `fire()` with no `now` option, fully ordered, exactly like the 6-second timer.
     *
     * (2) Even restricted to `pagehide`, forcing only `current` (the edit that had not even been
     * captured by `fire()` yet) was not enough: an edit whose timer already fired, or that a
     * THIRD edit's arrival already pulled off `current`, sits in `unstarted` - taken, but with its
     * real `o.send` still waiting its turn on `sendChain`. That deferred `.then()` callback would
     * never get to run once the document is destroyed, so it was lost exactly like `current` used
     * to be. `flush({ teardown: true })` now drains the WHOLE `unstarted` list, in the order each
     * edit was captured, starting every one of them synchronously and immediately, THEN does the
     * same for `current` if anything is still waiting there. Each entry's `start()` is idempotent
     * (see `fire()` above), so when its own place in `sendChain` later gets a turn anyway, it is a
     * no-op - every edit is still sent EXACTLY ONCE.
     *
     * The accepted trade, and ONLY at the literal moment of teardown: an edit forced out this way
     * may reach the server out of order relative to one already genuinely in flight before it (the
     * server timestamps on arrival). Normal use - the 6s timer, a second edit, an unmount/
     * navigation flush - stays fully ordered, because the page is not disappearing out from under
     * the chain in any of those cases. Plan 3 makes no server change to close this residual; a
     * later server-side ordered submission (e.g. a client sequence number on each change, so the
     * server can re-order instead of trusting arrival time) could.
     */
    flush(opts?: { teardown?: boolean }) {
      if (opts?.teardown) {
        for (const entry of [...unstarted]) entry.start();
        if (current) void fire({ now: true });
      } else {
        void fire();
      }
    },
  };
}
