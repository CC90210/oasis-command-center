/**
 * lib/os/runs/follow.ts - follow a run from the database: replay the events the
 * follower has not seen, then the live ones, until the run ends.
 *
 * The browser never reads a model stream. It reads THIS, which reads what the
 * driver wrote (./executor.ts, or a producer: ./producer.ts). That is why the
 * same call serves the page that sent the message, the page that comes back an
 * hour later, and a second tab: the events are in the table in order, and a
 * follower asks for "everything after seq N".
 *
 * Two shapes:
 *   - one run, for a window (the re-attach route, TAIL_WINDOW_MS): ends with a
 *     `window` frame, and the browser asks again from the last seq it saw;
 *   - the whole queue (`queue: true`, the route that sends a message and drives
 *     it): when a run ends, the next queued run in the conversation is followed,
 *     until none is left.
 *
 * ENDINGS. A run's status flips first and its closing events (error, done) are
 * written just after, so a follower waits for `done`. If a driver died between
 * the two, `done` never comes: after DONE_GRACE_MS the follower closes the run
 * itself from the run row.
 *
 * A QUEUED RUN WITH NO DRIVER. A message sent while another was running is
 * picked up by that run's driver when it finishes. If that driver is gone (the
 * browser closed, the Worker was evicted), the queued run would wait forever,
 * so a follower that sees a queued run with no live runner for a few polls
 * calls `needDriver`, and the caller starts one.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { conversationActivity, failQueuedComputerRun, nextActiveRun, pollRun, reapStale, type Run, type RunScope } from "./store";
import { COMPUTER_BUSY_TIMEOUT_MS, COMPUTER_MAX_QUEUED_MS, COMPUTER_NOT_ANSWERING_MS, isTerminalStatus, type RunEvent, type RunExecutor, type RunSource, type RunStatus } from "./types";
import { blockedReasonCode } from "@/lib/os/channel/outcome";
import type { ComputerAnswerState } from "@/lib/devices/presence";

export type RunHead = {
  id: string;
  conversationId: string;
  seq: number;
  status: RunStatus;
  userText: string;
  finalText: string | null;
  errorCode: string | null;
  source: RunSource;
  executor: RunExecutor;
};

export type Frame =
  | { type: "run"; run: RunHead }
  | { type: "event"; runId: string; event: RunEvent }
  | { type: "end"; run: RunHead }
  | { type: "window" }
  | { type: "ping" }
  | { type: "gone"; runId: string };

export function headOf(run: Run): RunHead {
  return {
    id: run.id,
    conversationId: run.conversationId,
    seq: run.seq,
    status: run.status,
    userText: run.userText,
    finalText: run.finalText,
    errorCode: run.errorCode,
    source: run.source,
    executor: run.executor,
  };
}

export const DONE_GRACE_MS = 3_000;
const REAP_EVERY_MS = 15_000;
const PING_EVERY_MS = 15_000;
const QUIET_POLLS_BEFORE_DRIVER = 3;

export type FollowOptions = {
  db: Client;
  scope: RunScope;
  runId: string;
  afterSeq: number;
  /**
   * End with a `window` frame after this long. Absent: follow until the run (or
   * queue) ends. A function is asked on every poll, so a follower that starts
   * driving stops being limited (a driver must hold its connection open).
   */
  windowMs?: number | (() => number | undefined);
  /** Follow the next queued run too, until the conversation has none. */
  queue?: boolean;
  /** The follower's connection is gone. */
  gone?: () => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** A queued run has no live driver: start one. */
  needDriver?: () => Promise<void>;
  /** Wait between polls, by how long this follow has run. */
  pollMs?: (elapsedMs: number) => number;
  /**
   * O4: this person's best-ranked paired computer, read fresh on every poll
   * of a QUEUED computer-executor run only (lib/devices/presence.ts
   * computerAnswerState). Absent for every other follow (the chat route
   * that never dispatches to a computer need not know about this at all).
   */
  computerState?: () => Promise<ComputerAnswerState>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultPoll = (elapsed: number) => (elapsed < 20_000 ? 500 : 1_000);

export async function* followRun(o: FollowOptions): AsyncGenerator<Frame> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? defaultSleep;
  const poll = o.pollMs ?? defaultPoll;
  const startedAt = now().getTime();
  let runId = o.runId;
  let cursor = o.afterSeq;
  let announced = false;
  let sawDone = false;
  let terminalSince: number | null = null;
  let quiet = 0;
  let askedDriver = false;
  let lastReap = startedAt;
  let lastFrameAt = startedAt;
  /** O4: when this run most recently became first-in-line with nothing running ahead of it -- NOT when it was sent. */
  let firstInLineSince: number | null = null;

  for (;;) {
    if (o.gone?.()) return;
    const { events, run } = await pollRun(o.db, o.scope, runId, cursor);
    if (!run) {
      yield { type: "gone", runId };
      return;
    }
    if (!announced) {
      announced = true;
      yield { type: "run", run: headOf(run) };
    }
    for (const event of events) {
      cursor = event.seq;
      if (event.kind === "done") sawDone = true;
      yield { type: "event", runId, event };
    }

    const t = now().getTime();
    if (isTerminalStatus(run.status)) {
      terminalSince ??= t;
      if (sawDone || t - terminalSince >= DONE_GRACE_MS) {
        if (!sawDone) {
          // The writer ended the run and stopped before its closing events: close it from the row.
          yield { type: "event", runId, event: { seq: cursor + 1, kind: "done", data: { status: run.status } } };
        }
        yield { type: "end", run: headOf(run) };
        if (!o.queue) return;
        const next = await nextActiveRun(o.db, o.scope, run.conversationId, run.seq);
        if (!next) return;
        runId = next.id;
        cursor = 0;
        announced = false;
        sawDone = false;
        terminalSince = null;
        quiet = 0;
        continue;
      }
    } else if (run.status === "queued" && run.executor === "computer") {
      // O4 "OFFLINE AND HONEST". The absolute cap applies whatever is
      // ahead of it: still queued 10 minutes after it was SENT is
      // computer_not_answering, no matter why.
      const queuedSinceMs = Date.parse(run.createdAt);
      let failedCode: string | null = Number.isFinite(queuedSinceMs) && t - queuedSinceMs >= COMPUTER_MAX_QUEUED_MS ? "computer_not_answering" : null;
      // The other two clocks start when this run becomes FIRST IN LINE
      // (nothing running ahead of it in its conversation), never from when
      // it was sent -- a follow-up waiting behind a long reply in the SAME
      // conversation is never penalised for that wait.
      const activity = await conversationActivity(o.db, o.scope, run.conversationId, now());
      if (activity.live) {
        firstInLineSince = null;
      } else {
        firstInLineSince ??= t;
        const waitedMs = t - firstInLineSince;
        const cs = o.computerState ? await o.computerState() : null;
        if (!failedCode) {
          if (cs?.startsWith("blocked:")) {
            // A blocked computer is not "busy": it fails at once.
            failedCode = blockedReasonCode(cs.slice("blocked:".length));
          } else if (cs === "busy") {
            if (waitedMs >= COMPUTER_BUSY_TIMEOUT_MS) failedCode = "computer_busy_timeout";
          } else {
            // 'offline', 'not_approved', or unknown (no computerState hook at all): no live claimer.
            if (waitedMs >= COMPUTER_NOT_ANSWERING_MS) failedCode = "computer_not_answering";
          }
        }
      }
      if (failedCode) await failQueuedComputerRun(o.db, o.scope, run.id, failedCode, now());
    } else if (run.status === "queued") {
      const activity = await conversationActivity(o.db, o.scope, run.conversationId, now());
      quiet = activity.live ? 0 : quiet + 1;
      if (quiet >= QUIET_POLLS_BEFORE_DRIVER && !askedDriver && o.needDriver) {
        askedDriver = true;
        await o.needDriver();
      }
    } else if (t - lastReap >= REAP_EVERY_MS) {
      // Running: a writer that went silent past its limit is dead; closing the run lets the queue behind it go.
      lastReap = t;
      const closed = await reapStale(o.db, o.scope, run.conversationId, now());
      if (closed.length > 0 && o.needDriver) {
        const activity = await conversationActivity(o.db, o.scope, run.conversationId, now());
        if (activity.queued > 0 && !askedDriver) {
          askedDriver = true;
          await o.needDriver();
        }
      }
    }

    const windowMs = typeof o.windowMs === "function" ? o.windowMs() : o.windowMs;
    if (windowMs !== undefined && t - startedAt >= windowMs) {
      yield { type: "window" };
      return;
    }
    if (events.length > 0) lastFrameAt = t;
    else if (t - lastFrameAt >= PING_EVERY_MS) {
      // Silence is normal (the app is thinking); an idle connection is closed by proxies.
      lastFrameAt = t;
      yield { type: "ping" };
    }
    await sleep(poll(t - startedAt));
  }
}
