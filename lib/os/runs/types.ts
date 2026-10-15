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

export const RUN_STATUSES = ["queued", "running", "done", "failed", "cancelled", "interrupted", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Plain words used anywhere a durable run state is shown. */
export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  queued: "Waiting",
  running: "Running",
  done: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  missed: "Missed",
};

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status];
}

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

/** A computer-claimed run's token lifetime: the longest an MCP or run token may outlive (O4 security rule 7). */
export const COMPUTER_CLAIM_DEADLINE_MS = 20 * 60_000;
/**
 * The three clocks that keep a computer-dispatched chat run from waiting
 * forever (O4 "OFFLINE AND HONEST"), all measured from the moment the run
 * becomes FIRST IN ITS CONVERSATION with nothing running ahead of it, not
 * from when it was sent -- a follow-up waiting behind a long reply in the
 * same conversation is never penalised for that wait.
 */
export const COMPUTER_NOT_ANSWERING_MS = 20_000;
export const COMPUTER_BUSY_TIMEOUT_MS = 5 * 60_000;
/** The absolute cap, regardless of why: still queued this long and it fails, whatever the computer last reported. */
export const COMPUTER_MAX_QUEUED_MS = 10 * 60_000;

/**
 * Availability failures an explicitly opted-in computer run may answer through
 * the workspace API instead. This is deliberately an allowlist: approval,
 * ownership, seat and locked-profile failures are authorization/security
 * boundaries and must never be converted into API spend.
 */
export const WORKSPACE_API_FALLBACK_REASONS = [
  "computer_offline",
  "computer_not_answering",
  "computer_busy_timeout",
  "subscription_auth_failure",
  "subscription_limit",
  "cli_account_unsupported",
  "cli_not_found",
  "cli_outdated",
] as const;

export type WorkspaceApiFallbackReason = (typeof WORKSPACE_API_FALLBACK_REASONS)[number];

export function isWorkspaceApiFallbackReason(value: unknown): value is WorkspaceApiFallbackReason {
  return typeof value === "string" && (WORKSPACE_API_FALLBACK_REASONS as readonly string[]).includes(value);
}

/**
 * Who drives a run and writes its events:
 *   worker      the department chat's driver in the Worker (the default);
 *   producer    a paired computer's bridge, posting events with a run token --
 *               either the legacy push path's handoff (attachProducer, a
 *               Worker-started run handed over mid-reply) or O4's pull
 *               dispatch (claimComputerRun sets source='producer' in the SAME
 *               statement that claims the run, so both paths write events
 *               through the identical door: ./producer.ts ingestBatch);
 *   automation  a department task's run (lib/automations), driven only by the
 *               automation driver (executor.ts driveAutomationRun) that claims
 *               it BY ID. No chat driver ever claims one (store.ts claimNextRun),
 *               the follow route never starts a driver for one, and no message
 *               can be sent into a conversation that holds one (send.ts).
 * A worker or automation run is stale after RUN_STALE_MS of silence.
 */
export type RunSource = "worker" | "producer" | "automation";

/**
 * Who may claim a run (O4, migration bravo__213):
 *   worker    the Worker's own chat driver (claimNextRun) -- the default, and
 *             every run ever enqueued before this column existed;
 *   computer  claimed ONLY by the claim route's compare-and-swap
 *             (claimComputerRun), for a person whose effective engine is
 *             their own paired computer. claimNextRun explicitly excludes
 *             executor='computer', so a chat Worker driver can never run one
 *             on the workspace's API account. Explicit workspace_api consent
 *             changes the queued row to worker before any hosted claim.
 */
export const RUN_EXECUTORS = ["worker", "computer"] as const;
export type RunExecutor = (typeof RUN_EXECUTORS)[number];

export function isRunExecutor(value: unknown): value is RunExecutor {
  return typeof value === "string" && (RUN_EXECUTORS as readonly string[]).includes(value);
}

/**
 * Why a run was queued (O4, also read by O5's automations): a chat message
 * goes before a "Run now" test, which goes before a scheduled automation --
 * the claim route's compare-and-swap orders by this, so a person waiting on
 * an answer is never queued behind work that merely happened to be enqueued
 * first. O4 itself only ever writes 'chat'.
 */
export const RUN_ORIGINS = ["chat", "automation", "test"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

export function isRunOrigin(value: unknown): value is RunOrigin {
  return typeof value === "string" && (RUN_ORIGINS as readonly string[]).includes(value);
}

/**
 * Why an automation run failed, beyond the channel's own failure codes
 * (lib/os/channel/outcome.ts TURN_FAILURE_CODES):
 *   run_timeout          the run reached its time limit (ExecutorDeps.deadlineMs)
 *                        and was stopped. Its model call's ledger row is closed
 *                        as cancelled once the stream unwinds; a provider stream
 *                        that never yields again leaves the row pending until
 *                        the reservation sweep expires it (RESERVATION_TTL_MS);
 *   sources_unavailable  the department's data could not be read for the run, so
 *                        no model was asked.
 * Neither is a verdict on the workspace's AI account or the department chat, so
 * neither is recorded as the channel's last turn.
 */
export const RUN_FAILURE_CODES = [
  "run_timeout",
  "sources_unavailable",
  "ai_account_unavailable",
  "department_unavailable",
  "template_version_unknown",
  "tools_invalid",
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export function isRunFailureCode(code: unknown): code is RunFailureCode {
  return typeof code === "string" && (RUN_FAILURE_CODES as readonly string[]).includes(code);
}
