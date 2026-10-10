/**
 * lib/os/runs/types.ts - the vocabulary of a department-channel run, shared by
 * the server (store, executor, routes) and the browser (the run view).
 *
 * A RUN is one message a person sent to a department channel and everything the
 * department did to answer it. It has an id, lives in the database
 * (migration bravo__207), and is finished by a server-side driver, not by the
 * browser: leaving the page does not stop it. The browser follows a run by its
 * EVENTS, an append-only list in order (seq 1, 2, 3...). A browser that comes
 * back replays the events it has not seen, then follows the live ones.
 *
 * PURE: no server imports. Safe in client code and in bare-node tests.
 */

export const RUN_STATUSES = ["queued", "running", "done", "failed", "cancelled", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/** A run that will not change again. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

export const RUN_EVENT_KINDS = ["agent", "status", "thinking", "tool", "delta", "usage", "error", "done"] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export function isRunEventKind(value: unknown): value is RunEventKind {
  return typeof value === "string" && (RUN_EVENT_KINDS as readonly string[]).includes(value);
}

/** One saved event. `data` is the JSON the event kind documents in lib/os/runs/reduce.ts. */
export type RunEvent = { seq: number; kind: RunEventKind; data: Record<string, unknown> };

/** Longest message a person can send into a channel, and longest title a conversation keeps. */
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_TITLE_CHARS = 80;
/** Messages waiting behind a running one, per conversation. */
export const MAX_QUEUED_RUNS = 5;
/** A running run whose driver (in the Worker) has not reported for this long is dead. */
export const RUN_STALE_MS = 45_000;
/** A run whose producer (the paired computer's bridge, heartbeating every ~25 s) has been silent this long is dead. */
export const RUN_STALE_PRODUCER_MS = 120_000;
/**
 * Events a producer posts are numbered from 1 by the producer; they are stored
 * at PRODUCER_SEQ_BASE + n. Seq 1..99 belong to the Worker (the agent line, the
 * first status), so the two writers can never collide, and a resent event lands
 * on the same stored seq (and is ignored).
 */
export const PRODUCER_SEQ_BASE = 100;
/** A re-attach stream lives this long, then ends; the browser asks again with the last seq it saw. */
export const TAIL_WINDOW_MS = 25_000;

/**
 * Who drives a run and writes its events:
 *   worker      the department chat's driver in the Worker (the default);
 *   producer    the paired computer's bridge, posting events with a run token;
 *   automation  a department task's run (lib/automations), driven only by the
 *               automation driver (executor.ts driveAutomationRun) that claims
 *               it BY ID. No chat driver ever claims one (store.ts claimNextRun),
 *               the follow route never starts a driver for one, and no message
 *               can be sent into a conversation that holds one (send.ts).
 * A worker or automation run is stale after RUN_STALE_MS of silence.
 */
export type RunSource = "worker" | "producer" | "automation";

/**
 * Why an automation run failed, beyond the channel's own failure codes
 * (lib/os/channel/outcome.ts TURN_FAILURE_CODES):
 *   run_timeout          the run reached its time limit (ExecutorDeps.deadlineMs)
 *                        and was stopped; the model call's ledger row says cancelled;
 *   sources_unavailable  the department's data could not be read for the run, so
 *                        no model was asked.
 * Neither is a verdict on the workspace's AI account or the department chat, so
 * neither is recorded as the channel's last turn.
 */
export const RUN_FAILURE_CODES = ["run_timeout", "sources_unavailable"] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export function isRunFailureCode(code: unknown): code is RunFailureCode {
  return typeof code === "string" && (RUN_FAILURE_CODES as readonly string[]).includes(code);
}
