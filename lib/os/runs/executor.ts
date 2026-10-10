/**
 * lib/os/runs/executor.ts - the server-side driver of department-channel runs.
 *
 * WHY. A channel turn used to live and die with the browser's request: the
 * reply streamed straight to the page, so leaving the page ended it and nothing
 * was saved. Now the DRIVER runs the turn and writes what it does to the
 * database as it goes (./store.ts: the run row and its append-only events); the
 * browser only follows. Nothing here reads a request, a response or a client
 * connection, so a client that leaves changes nothing about the run.
 *
 * ONE RUN, START TO END (executeRun)
 *   1. startTurn: the department, the AI account, the budget, the prompt and
 *      the meter (lib/os/department-agent.ts prepareAgentTurn through
 *      ./turn-starter.ts). A refusal is the run's failure, with the same codes
 *      the channel always showed.
 *   2. The turn's events become run events (./activity.ts): the activity trail,
 *      the model's reasoning where its provider shows it, reply text.
 *   3. Every few seconds the driver reports in (heartbeat) and learns whether
 *      the person pressed Stop. Stop ends the model call: on the paired computer
 *      by closing the request, for a hosted provider by stopping at its next
 *      event. Either way the call's ledger row says `cancelled`.
 *   4. The run ends done, failed or cancelled with its answer saved, and the
 *      channel's last-turn outcome is recorded as before.
 *
 * THE LEDGER. A model call writes its one ai_usage_events row itself (the
 * meter in lib/ai/usage.ts); this module adds none and removes none. A queued
 * run that never starts calls no model, so it writes nothing. A driver that
 * dies mid-call leaves a pending reservation that the ledger's own sweep
 * settles (RESERVATION_TTL_MS).
 *
 * ONE DRIVER PER CONVERSATION. driveConversation runs the conversation's queued
 * runs one after another; claimNextRun lets only one driver have a run, and
 * every write by a driver is guarded by its lease (./store.ts).
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { ChatMessage, StreamEvent } from "@/lib/providers";
import type { DeskEvent } from "@/lib/os/desk/turn";
import { classifyStreamError, failureCopy, isTurnFailureCode, type FailureModel, type TurnFailureCode } from "@/lib/os/channel/outcome";
import { redactAll } from "@/lib/secret-redaction";
import { RunRecorder } from "./activity";
import {
  appendEvents,
  claimNextRun,
  finishRun,
  heartbeat,
  historyFor,
  reapStale,
  type Run,
  type RunScope,
} from "./store";
import type { RunEvent, RunStatus } from "./types";

export type TurnStart =
  | {
      ok: true;
      /** The `agent` event's data (display name, department, lookups, what ran it). */
      agent: Record<string, unknown>;
      channelKey: string;
      agentSlug: string;
      /** The model a provider_404 is about, for those who may pick another (null for everyone else). */
      failureModel: () => FailureModel | null;
      stream: AsyncGenerator<StreamEvent | DeskEvent>;
    }
  | {
      ok: false;
      status: number;
      error: string;
      /** A verdict on the workspace's AI account: recorded as the channel's last turn. */
      recordAs?: TurnFailureCode;
      agentSlug?: string;
      channelKey?: string;
    };

export type ExecutorDeps = {
  db: Client;
  scope: RunScope;
  /** The department's label: the persona names in reasoning are replaced by it. */
  departmentLabel: string;
  now?: () => Date;
  /** How often a running driver reports in and learns about Stop. */
  heartbeatMs?: number;
  startTurn: (input: { run: Run; messages: ChatMessage[]; signal: AbortSignal }) => Promise<TurnStart>;
  recordOutcome: (o: { channelKey: string; agentSlug: string; ok: boolean; code: TurnFailureCode | null }) => Promise<void>;
};

/** How long Stop waits for a hosted provider's stream to unwind before the run is finished anyway. */
const UNWIND_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RunEnd = RunStatus | "lost";

export async function executeRun(deps: ExecutorDeps, run: Run, leaseId: string): Promise<RunEnd> {
  const { db, scope } = deps;
  const now = deps.now ?? (() => new Date());
  const recorder = new RunRecorder(deps.departmentLabel, () => now().getTime(), run.showThinking);
  const ac = new AbortController();
  const state = { cancelled: false, lost: false };
  let chain: Promise<void> = Promise.resolve();

  const write = (events: RunEvent[]) => {
    if (events.length === 0) return;
    chain = chain.then(async () => {
      try {
        if (!(await appendEvents(db, scope, run.id, events, now())) && !state.lost) {
          // The run is gone (its conversation was deleted): stop working on it.
          state.lost = true;
          ac.abort();
        }
      } catch (err) {
        console.error("[os.runs.executor.write]", { tenantId: scope.tenantId, runId: run.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        const hb = await heartbeat(db, scope, run.id, leaseId, now());
        if (!hb.owned) {
          state.lost = true;
          ac.abort();
        } else if (hb.cancel && !state.cancelled) {
          state.cancelled = true;
          ac.abort();
        }
        write(recorder.flushIfDue());
      } catch (err) {
        console.error("[os.runs.executor.heartbeat]", { tenantId: scope.tenantId, runId: run.id, error: err instanceof Error ? err.message : String(err) });
      } finally {
        ticking = false;
      }
    })();
  }, deps.heartbeatMs ?? 3_000);

  const log = (code: string, extra: Record<string, unknown> = {}) =>
    console.error("[os.runs.failure]", { tenantId: scope.tenantId, department: run.department, agentSlug: run.agentSlug, runId: run.id, code, ...extra });

  let agent: Record<string, unknown> | null = null;
  let channelKey: string | null = null;
  let turnAgentSlug: string | null = null;
  // A failure code: one of the channel's (outcome.ts), or a refusal code the copy table also knows.
  let failure: string | null = null;
  let failureModel: FailureModel | null = null;
  let refusal: { recordAs?: TurnFailureCode } | null = null;

  try {
    const history = await historyFor(db, scope, run.conversationId, run.seq);
    const messages: ChatMessage[] = [...history, { role: "user", content: run.userText }];

    let started: TurnStart;
    try {
      started = await deps.startTurn({ run, messages, signal: ac.signal });
    } catch (err) {
      log("stream_failed", { stage: "start", detail: redactAll(err instanceof Error ? err.message : String(err)).slice(0, 160) });
      started = { ok: false, status: 500, error: "stream_failed" };
    }

    if (!started.ok) {
      failure = started.error;
      refusal = { recordAs: started.recordAs };
      channelKey = started.channelKey ?? null;
      turnAgentSlug = started.agentSlug ?? null;
      log(started.error, { stage: "pre_stream", status: started.status });
    } else {
      agent = started.agent;
      channelKey = started.channelKey;
      turnAgentSlug = started.agentSlug;
      write(recorder.start(started.agent));
      const it = started.stream[Symbol.asyncIterator]();
      const aborted = new Promise<"aborted">((resolve) => {
        if (ac.signal.aborted) resolve("aborted");
        else ac.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      let unwound = false;
      try {
        for (;;) {
          if (state.cancelled || state.lost) break;
          const pending = it.next();
          pending.catch(() => undefined);
          const got = await Promise.race([pending, aborted]);
          if (got === "aborted") break;
          if (got.done) {
            unwound = true;
            break;
          }
          if (state.cancelled || state.lost) break;
          const ev = got.value;
          if (ev.type === "error") {
            if (!failure) {
              failure = classifyStreamError(ev.message);
              if (failure === "provider_404") failureModel = started.failureModel();
              log(failure, {
                stage: "stream",
                ...(failure === "provider_error" || failure === "stream_failed" ? { detail: redactAll(ev.message).slice(0, 160) } : {}),
              });
            }
          } else if (ev.type === "done" && "usageKnown" in ev && ev.usageKnown === false) {
            // A tool turn with a step that reported no usage has no known total.
            write(recorder.flush());
          } else {
            write(recorder.push(ev));
          }
        }
      } catch (err) {
        if (!failure) {
          failure = "stream_failed";
          log("stream_failed", { stage: "stream", detail: redactAll(err instanceof Error ? err.message : String(err)).slice(0, 160) });
        }
      } finally {
        if (!unwound) {
          // Stop (or a lost run): end the stream so its call writes its ledger
          // row. A hosted provider's stream unwinds at its next event, so this
          // waits a bounded time, never forever.
          await Promise.race([it.return(undefined).then(() => undefined, () => undefined), sleep(UNWIND_MS)]);
        }
      }
    }

    if (state.lost) {
      await chain;
      return "lost";
    }

    write(recorder.flush());
    if (failure === null && !state.cancelled && !recorder.replyText.trim() && started.ok) {
      failure = "reply_empty";
      log(failure, { stage: "stream" });
    }
    const status: Exclude<RunStatus, "queued" | "running" | "interrupted"> = state.cancelled ? "cancelled" : failure ? "failed" : "done";
    write(recorder.closeOpenTools(status === "done"));
    await chain;

    const text = recorder.replyText.trim() ? recorder.replyText : null;
    const finished = await finishRun(db, scope, run.id, leaseId, {
      status,
      finalText: text,
      errorCode: status === "failed" ? failure : null,
      inputTokens: recorder.tokens.input,
      outputTokens: recorder.tokens.output,
      agent,
      now: now(),
    });
    if (!finished) return "lost";

    const closing: RunEvent[] = [];
    if (status === "failed" && failure) {
      closing.push(
        recorder.event("error", {
          code: failure,
          message: failureCopy(failure, { canManageAi: false, model: failureModel }).sentence,
          ...(failureModel ? { model: failureModel } : {}),
        }),
      );
    }
    closing.push(recorder.event("done", { status }));
    write(closing);
    await chain;

    // The channel's last turn, as the route recorded it before runs: a reply
    // clears an old failure, a failure says why. A refusal that is no verdict
    // on the AI account (no key tried) and a Stop record nothing.
    if (status !== "cancelled") {
      const code = status === "failed" && isTurnFailureCode(failure) ? failure : null;
      const slug = turnAgentSlug ?? run.agentSlug;
      const key = channelKey;
      if (key && (refusal === null || refusal.recordAs)) {
        await deps
          .recordOutcome({ channelKey: key, agentSlug: slug, ok: status === "done", code: refusal?.recordAs ?? code })
          .catch((err: unknown) =>
            console.error("[os.runs.executor.outcome]", { tenantId: scope.tenantId, runId: run.id, error: err instanceof Error ? err.message : String(err) }),
          );
      }
    }
    return status;
  } finally {
    clearInterval(timer);
    await chain;
  }
}

/**
 * Run the conversation's queued runs, one after another, until none is left or
 * another driver holds the conversation. Runs that were left `running` by a
 * driver that died are closed first.
 */
export async function driveConversation(deps: ExecutorDeps, conversationId: string, opts: { maxRuns?: number } = {}): Promise<string[]> {
  const now = deps.now ?? (() => new Date());
  const ran: string[] = [];
  for (let i = 0; i < (opts.maxRuns ?? 12); i++) {
    await reapStale(deps.db, deps.scope, conversationId, now());
    const lease = crypto.randomUUID();
    const run = await claimNextRun(deps.db, deps.scope, conversationId, lease, now());
    if (!run) break;
    ran.push(run.id);
    try {
      await executeRun(deps, run, lease);
    } catch (err) {
      // An unexpected throw must not leave the run `running` for the next driver to wait out.
      console.error("[os.runs.executor]", { tenantId: deps.scope.tenantId, runId: run.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      await finishRun(deps.db, deps.scope, run.id, lease, {
        status: "failed",
        finalText: null,
        errorCode: "stream_failed",
        inputTokens: null,
        outputTokens: null,
        agent: null,
        now: now(),
      }).catch(() => false);
    }
  }
  return ran;
}
