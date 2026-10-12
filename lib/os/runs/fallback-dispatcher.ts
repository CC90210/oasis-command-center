import "server-only";

import type { Client } from "@libsql/client";
import { blockedReasonCode } from "@/lib/os/channel/outcome";
import type { ComputerAnswerState } from "@/lib/devices/presence";
import {
  COMPUTER_BUSY_TIMEOUT_MS,
  COMPUTER_MAX_QUEUED_MS,
  COMPUTER_NOT_ANSWERING_MS,
  isWorkspaceApiFallbackReason,
  type WorkspaceApiFallbackReason,
} from "./types";
import {
  failQueuedComputerRun,
  failQueuedFallbackRun,
  fallbackQueuedComputerRun,
  listQueuedFallbackRuns,
  listStaleRunningFallbackRuns,
  markFirstInLine,
  reapStale,
  type Run,
} from "./store";
import { computerStateForTarget } from "./send";
import { resolveStoredFallbackSession, type RunSession, type SessionRefusal } from "./session";
import { executorDepsFor } from "./turn-starter";
import { driveConversation } from "./executor";

export type FallbackQueueDecision =
  | { action: "wait" }
  | { action: "fallback"; reason: WorkspaceApiFallbackReason }
  | { action: "fail"; code: string };

/** One source for the durable dispatcher's availability clocks. Approval and
 * unknown blocked states are terminal failures, never permission to spend. */
export function fallbackQueueDecision(input: {
  run: Pick<Run, "createdAt">;
  firstInLineAt: string;
  state: ComputerAnswerState;
  nowMs: number;
}): FallbackQueueDecision {
  const createdAt = Date.parse(input.run.createdAt);
  const firstAt = Date.parse(input.firstInLineAt);
  const absoluteExpired = Number.isFinite(createdAt) && input.nowMs - createdAt >= COMPUTER_MAX_QUEUED_MS;
  const waitedMs = Number.isFinite(firstAt) ? input.nowMs - firstAt : 0;

  if (input.state === "not_approved") return { action: "fail", code: "computer_not_approved" };
  if (input.state.startsWith("blocked:")) {
    const raw = input.state.slice("blocked:".length);
    const code = blockedReasonCode(raw);
    return isWorkspaceApiFallbackReason(raw) && raw === code
      ? { action: "fallback", reason: raw }
      : { action: "fail", code };
  }
  if (absoluteExpired) return { action: "fallback", reason: "computer_not_answering" };
  if (input.state === "busy") {
    return waitedMs >= COMPUTER_BUSY_TIMEOUT_MS
      ? { action: "fallback", reason: "computer_busy_timeout" }
      : { action: "wait" };
  }
  if (input.state === "offline") {
    return waitedMs >= COMPUTER_NOT_ANSWERING_MS
      ? { action: "fallback", reason: "computer_not_answering" }
      : { action: "wait" };
  }
  return { action: "wait" };
}

export type FallbackDispatchSummary = {
  scanned: number;
  promoted: string[];
  started: string[];
  failed: string[];
  deferred: string[];
  recovered: string[];
};

/** Promote and drive opted-in device fallbacks without relying on an open
 * browser stream. Intended for the minute scheduler; all mutations retain the
 * original store CAS, so a connector claim or another scheduler tick wins
 * cleanly and exactly one executor can start each run. */
export async function dispatchDueEngineFallbacks(input: {
  db: Client;
  now?: Date;
  limit?: number;
  deps?: {
    readState?: (scope: { tenantId: string; userId: string }, run: Run) => Promise<ComputerAnswerState>;
    resolveSession?: (args: {
      tenantId: string;
      userId: string;
      department: string;
      snapshot: {
        targetPairingId: string | null;
        runtimeEngineKind: Run["runtimeEngineKind"];
        runtimeEngineName: string | null;
        runtimeFallbackPolicy: "none" | "workspace_api" | null;
        runtimeFallbackReason: string | null;
        runtimeApiProvider: Run["runtimeApiProvider"];
        runtimeApiModel: string | null;
      };
    }) => Promise<{ ok: true; session: RunSession } | SessionRefusal>;
    drive?: (session: RunSession, conversationId: string, runId: string) => Promise<void>;
  };
}): Promise<FallbackDispatchSummary> {
  const now = input.now ?? new Date();
  const summary: FallbackDispatchSummary = {
    scanned: 0,
    promoted: [],
    started: [],
    failed: [],
    deferred: [],
    recovered: [],
  };

  // The active scheduler is an HTTP forwarder. If that origin request or its
  // serverless process dies, the executor heartbeat stops. Recover those
  // exact fallback conversations before looking at their queued followers;
  // reapStale's lease/heartbeat CAS cannot interrupt a live driver.
  const stale = await listStaleRunningFallbackRuns(input.db, now, input.limit ?? 100);
  for (const run of stale) {
    const reaped = await reapStale(
      input.db,
      { tenantId: run.tenantId, userId: run.userId },
      run.conversationId,
      now,
    );
    if (reaped.includes(run.id)) summary.recovered.push(run.id);
  }

  const candidates = await listQueuedFallbackRuns(input.db, input.limit ?? 100);
  summary.scanned = candidates.length;
  const ready: Array<{ run: Run; reason: WorkspaceApiFallbackReason }> = [];

  for (const run of candidates) {
    const scope = { tenantId: run.tenantId, userId: run.userId };
    if (run.executor === "worker") {
      if (isWorkspaceApiFallbackReason(run.runtimeFallbackReason)) {
        ready.push({ run, reason: run.runtimeFallbackReason });
      }
      continue;
    }

    const firstInLineAt = await markFirstInLine(input.db, scope, run, now);
    if (!firstInLineAt) continue;
    const state = input.deps?.readState
      ? await input.deps.readState(scope, run)
      : await computerStateForTarget(scope)(run);
    const decision = fallbackQueueDecision({ run, firstInLineAt, state, nowMs: now.getTime() });
    if (decision.action === "wait") continue;
    if (decision.action === "fail") {
      if (await failQueuedComputerRun(input.db, scope, run.id, decision.code, now)) summary.failed.push(run.id);
      continue;
    }
    if (await fallbackQueuedComputerRun(input.db, scope, run.id, decision.reason)) {
      summary.promoted.push(run.id);
      ready.push({ run, reason: decision.reason });
    }
  }

  // Resolve and drive each row separately, in conversation order. A scheduler
  // must never reuse the first fallback's API session for a later row whose
  // provider/model snapshot differs. maxRuns:1 makes that boundary explicit;
  // claimNextRun still supplies the conversation's ordering and lease CAS.
  const conversations = new Map<string, Array<{ run: Run; reason: WorkspaceApiFallbackReason }>>();
  for (const item of ready) {
    const key = `${item.run.tenantId}:${item.run.userId}:${item.run.conversationId}`;
    const group = conversations.get(key) ?? [];
    group.push(item);
    conversations.set(key, group);
  }

  await Promise.all(Array.from(conversations.values(), async (items) => {
    items.sort((a, b) => a.run.seq - b.run.seq);
    for (const { run, reason } of items) {
      const snapshot = {
        targetPairingId: run.targetPairingId,
        runtimeEngineKind: run.runtimeEngineKind,
        runtimeEngineName: run.runtimeEngineName,
        runtimeFallbackPolicy: run.runtimeFallbackPolicy,
        runtimeFallbackReason: reason,
        runtimeApiProvider: run.runtimeApiProvider,
        runtimeApiModel: run.runtimeApiModel,
      };
      const resolved = await (input.deps?.resolveSession ?? resolveStoredFallbackSession)({
        tenantId: run.tenantId,
        userId: run.userId,
        department: run.department,
        snapshot,
      });
      if (!resolved.ok) {
        // Read faults are retryable. Revoked seats, malformed snapshots and
        // removed workspaces are terminal authorization/configuration failures.
        if (resolved.status >= 500) {
          summary.deferred.push(run.id);
          continue;
        }
        const stopped = await failQueuedFallbackRun(
          input.db,
          { tenantId: run.tenantId, userId: run.userId },
          run.id,
          resolved.error,
          "Workspace API fallback could not start because this member or workspace is no longer eligible.",
          now,
        );
        if (stopped) summary.failed.push(run.id);
        continue;
      }
      try {
        if (input.deps?.drive) await input.deps.drive(resolved.session, run.conversationId, run.id);
        else await driveConversation(executorDepsFor(resolved.session, input.db), run.conversationId, { maxRuns: 1 });
        summary.started.push(run.id);
      } catch (error) {
        console.error("[os.runs.fallback-dispatcher] driver failed", {
          tenantId: run.tenantId,
          runId: run.id,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        summary.deferred.push(run.id);
      }
    }
  }));

  return summary;
}
