/**
 * lib/os/runs/send.ts - send a message into a department channel: what
 * POST /api/os/runs does once the session is resolved.
 *
 * Kept apart from the route so the property that matters can be tested without
 * a browser: THE RUN DOES NOT DEPEND ON THE PERSON STAYING. The driver is a
 * promise started here and handed to the platform (keepAlive); the response the
 * browser reads is only a follower of what the driver writes. When the browser
 * leaves, `onGone` ends the follower. It is deliberately not connected to the
 * driver: nothing in this file lets a disconnect reach it.
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { AgentEngineChoice } from "@/lib/ai/agent-engine";
import {
  conversationActivity,
  createConversation,
  enqueueRun,
  ensureConversation,
  getConversation,
  hasAutomationRun,
  type Conversation,
  type Run,
  type RunApiSnapshot,
  type RunScope,
} from "./store";
import { driveConversation, type ExecutorDeps } from "./executor";
import { followRun, headOf } from "./follow";
import { sseResponse } from "./sse";
import { keepAlive } from "./keepalive";
import { json } from "./scope";
import { getOwnComputers, type OwnComputer } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { runtimeAvailability } from "@/lib/bridge/runtime-availability";
import { bestComputerAnswerState, computerAnswerState, type ComputerAnswerState } from "@/lib/devices/presence";
import type { WorkspaceApiFallbackReason } from "./types";

/** The longest one request follows (and so holds a driver's connection). Past it the browser re-attaches. */
export const MAX_FOLLOW_MS = 14 * 60_000;

/**
 * The response that follows a run its caller is driving: `prelude` (the
 * caller's own first event), then run / ev / end frames (./sse.ts) from the
 * database. Following only: it starts no driver (no needDriver), and the
 * browser leaving ends only the following. Shared by sending a message and by
 * an automation's "Test run now".
 */
export function followRunResponse(args: {
  db: Client;
  scope: RunScope;
  runId: string;
  /** Follow the runs queued behind it too (a chat's queue). */
  queue?: boolean;
  windowMs?: number;
  prelude?: string;
  now?: () => Date;
  pollMs?: (elapsedMs: number) => number;
  /** O4: read fresh on every poll of a QUEUED computer-executor run (lib/os/runs/follow.ts FollowOptions.computerState). */
  computerState?: (run: Run) => Promise<ComputerAnswerState>;
  needDriver?: (run: Run, fallbackReason?: WorkspaceApiFallbackReason | null) => Promise<void>;
}): Response {
  let gone = false;
  const frames = followRun({
    db: args.db,
    scope: args.scope,
    runId: args.runId,
    afterSeq: 0,
    queue: args.queue ?? false,
    windowMs: args.windowMs ?? MAX_FOLLOW_MS,
    gone: () => gone,
    now: args.now,
    pollMs: args.pollMs,
    computerState: args.computerState,
    needDriver: args.needDriver,
  });
  return sseResponse(frames, { prelude: args.prelude, onGone: () => (gone = true) });
}

type TargetComputer = OwnComputer & { claimRuntimeState?: unknown };

type ComputerStateSource = {
  readTarget: (tenantId: string, pairingId: string) => Promise<TargetComputer | null>;
  readOwn: (tenantId: string, userId: string) => Promise<OwnComputer[]>;
  now: () => number;
};

async function readTargetComputer(tenantId: string, pairingId: string): Promise<TargetComputer | null> {
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select(
      "id, label, last_seen_at, revoked_at, scope, paired_via, claim_enabled_at, claim_state_at, claim_blocked_reason, claim_capacity, claim_runtime_state",
    )
    .eq("tenant_id", tenantId)
    .eq("id", pairingId)
    .maybeSingle();
  if (error) throw new Error(`computerStateForTarget: bridge_pairings read failed: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    label: typeof row.label === "string" && row.label.trim() ? row.label : "Unnamed computer",
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
    scope: typeof row.scope === "string" ? row.scope : null,
    pairedVia: typeof row.paired_via === "string" ? row.paired_via : null,
    claimEnabledAt: typeof row.claim_enabled_at === "string" ? row.claim_enabled_at : null,
    claimStateAt: typeof row.claim_state_at === "string" ? row.claim_state_at : null,
    claimBlockedReason: typeof row.claim_blocked_reason === "string" ? row.claim_blocked_reason : null,
    claimCapacity: typeof row.claim_capacity === "number" ? row.claim_capacity : row.claim_capacity == null ? null : Number(row.claim_capacity),
    claimRuntimeState: row.claim_runtime_state,
  };
}

/**
 * Read the state of the pairing frozen onto each queued run. V2 workspace
 * defaults commonly target the agents owner's computer, so substituting the
 * requester's best machine here would watch a different runtime than the one
 * allowed to claim. Legacy unbound rows retain the old own-computer lookup.
 */
export function computerStateForTarget(
  scope: RunScope,
  source: ComputerStateSource = { readTarget: readTargetComputer, readOwn: getOwnComputers, now: Date.now },
): (
  run: Pick<Run, "targetPairingId"> & Partial<Pick<Run, "runtimeEngineKind" | "runtimeEngineName">>,
) => Promise<ComputerAnswerState> {
  return async (run) => {
    try {
      if (run.targetPairingId) {
        const computer = await source.readTarget(scope.tenantId, run.targetPairingId);
        if (!computer || computer.revokedAt) return "not_approved";
        const pairingState = computerAnswerState(computer, source.now());
        if (
          (pairingState === "can_answer" || pairingState === "busy") &&
          (run.runtimeEngineKind === "cli" || run.runtimeEngineKind === "local") &&
          run.runtimeEngineName
        ) {
          const exactRuntime = runtimeAvailability(computer.claimRuntimeState, {
            engineKind: run.runtimeEngineKind === "cli" ? "subscription" : "local",
            engineName: run.runtimeEngineName,
          });
          // Quota is intentionally absent from the pairing-wide block. Read
          // it from this run's immutable engine snapshot so only that engine
          // falls back while another ready runtime stays claimable.
          if (!exactRuntime.ok && exactRuntime.fallbackReason === "subscription_limit") {
            return "blocked:subscription_limit";
          }
        }
        return pairingState;
      }
      const computers = await source.readOwn(scope.tenantId, scope.userId);
      return bestComputerAnswerState(computers.map((c) => computerAnswerState(c, source.now())));
    } catch (err) {
      console.error("[os.runs.send.computerState]", { tenantId: scope.tenantId, error: err instanceof Error ? err.message : String(err) });
      // An unreadable authorization row is not proof of availability. Keep
      // the public copy generic while the raw unknown block makes API
      // fallback fail closed in follow.ts.
      return "blocked:pairing_state_unavailable";
    }
  };
}

/** Backward-compatible name used by the stream route. */
export const computerStateFor = computerStateForTarget;

export type SendInput = {
  department: string;
  agentSlug: string;
  text: string;
  conversationId: string;
  chatMode: "plan" | "build";
};

export async function sendMessage(args: {
  db: Client;
  deps: ExecutorDeps;
  showThinking: boolean;
  input: SendInput;
  now?: () => Date;
  /** The platform hook (tests pass a recorder). */
  keep?: typeof keepAlive;
  /** Test seam: how fast the follower polls. */
  pollMs?: (elapsedMs: number) => number;
  /**
   * Server-minted durable retry identity. Used by signed background jobs that
   * may outlive one HTTP request; browser calls never supply it.
   */
  idempotency?: { conversationId: string; runId: string };
  /**
   * O4: set when this person's effective engine is their OWN paired
   * computer and it can take work right now (lib/os/runs/session.ts
   * RunSession.computerDispatch). The message enqueues as executor
   * 'computer', origin 'chat', and this request starts NO driver: the run
   * sits queued until the claim route's compare-and-swap claims it. `label`
   * reaches the browser in the SSE prelude, for "Waiting for {label} to pick
   * this up".
   */
  computerDispatch?: {
    pairingId: string;
    label: string;
    engineKind: "cli" | "local";
    engineName: string;
    fallback: "none" | "workspace_api";
  } | null;
  /** Exact hosted account identity frozen into this run (and any opted-in fallback). */
  apiAccountSnapshot?: RunApiSnapshot | null;
  /** A device selection whose explicit workspace-API fallback was activated
   * before enqueue because its exact runtime was already unavailable. */
  fallbackFrom?: Exclude<AgentEngineChoice, { kind: "api" }> | null;
  fallbackReason?: WorkspaceApiFallbackReason | null;
  /** Builds the workspace-API driver only after an eligible guarded fallback transition. */
  computerFallbackDeps?: (reason: WorkspaceApiFallbackReason) => ExecutorDeps | null;
}): Promise<Response> {
  const { db, deps, input } = args;
  const scope = deps.scope;
  const now = args.now ?? (() => new Date());
  const keep = args.keep ?? keepAlive;
  const computerDispatch = args.computerDispatch ?? null;
  const apiAccountSnapshot = args.apiAccountSnapshot ?? null;
  const fallbackFrom = args.fallbackFrom ?? null;
  const fallbackReason = args.fallbackReason ?? null;
  const immediateFallback = !computerDispatch && fallbackFrom && fallbackReason
    ? {
        pairingId: fallbackFrom.pairingId ?? "",
        engineKind: fallbackFrom.kind === "cli" ? ("cli" as const) : ("local" as const),
        engineName: fallbackFrom.kind === "cli" ? fallbackFrom.cli : fallbackFrom.model,
      }
    : null;

  let conversation: Conversation | null;
  if (input.conversationId) {
    if (args.idempotency && args.idempotency.conversationId !== input.conversationId) {
      throw new Error("os.runs.send: idempotency conversation mismatch");
    }
    conversation = await getConversation(db, scope, input.conversationId);
    if (!conversation || conversation.department !== input.department) return json(404, { ok: false, error: "conversation_not_found" });
    // An automation's conversation is its record: a chat message there would
    // run with the chat's rights next to the automation's runs.
    if (await hasAutomationRun(db, scope, conversation.id)) return json(409, { ok: false, error: "automation_conversation" });
  } else if (args.idempotency) {
    conversation = await ensureConversation(db, scope, {
      id: args.idempotency.conversationId,
      department: input.department,
      agentSlug: input.agentSlug,
      now: now(),
    });
  } else {
    conversation = await createConversation(db, scope, { department: input.department, agentSlug: input.agentSlug, now: now() });
  }

  const queued = await enqueueRun(db, scope, {
    conversationId: conversation.id,
    text: input.text,
    chatMode: input.chatMode,
    showThinking: args.showThinking,
    now: now(),
    ...(args.idempotency ? { id: args.idempotency.runId, idempotent: true } : {}),
    ...(computerDispatch
      ? {
          executor: "computer" as const,
          origin: "chat" as const,
          targetPairingId: computerDispatch.pairingId,
          runtimeEngineKind: computerDispatch.engineKind,
          runtimeEngineName: computerDispatch.engineName,
          runtimeFallbackPolicy: computerDispatch.fallback,
          ...(computerDispatch.fallback === "workspace_api" && apiAccountSnapshot
            ? { runtimeApiSnapshot: apiAccountSnapshot }
            : {}),
        }
      : immediateFallback && apiAccountSnapshot
        ? {
            executor: "worker" as const,
            origin: "chat" as const,
            targetPairingId: immediateFallback.pairingId,
            runtimeEngineKind: immediateFallback.engineKind,
            runtimeEngineName: immediateFallback.engineName,
            runtimeFallbackPolicy: "workspace_api" as const,
            runtimeFallbackReason: fallbackReason!,
            runtimeApiSnapshot: apiAccountSnapshot,
          }
      : apiAccountSnapshot
        ? {
            runtimeEngineKind: "api" as const,
            runtimeEngineName: apiAccountSnapshot.provider,
            runtimeApiSnapshot: apiAccountSnapshot,
          }
        : {}),
  });
  if (!queued.ok) {
    return queued.reason === "queue_full" ? json(429, { ok: false, error: "queue_full" }) : json(404, { ok: false, error: "conversation_not_found" });
  }
  const run = queued.run;

  // Another driver (or, for a computer run, another queued/running message in
  // this conversation) has the conversation: it runs this message next.
  const activity = await conversationActivity(db, scope, conversation.id, now());
  if (activity.live && queued.created) {
    return json(202, { ok: true, mode: "queued", conversation_id: conversation.id, run: headOf(run) });
  }

  const prelude = `event: conversation\ndata: ${JSON.stringify({
    id: conversation.id,
    title: conversation.title || run.userText.slice(0, 80),
    ...(computerDispatch ? { computer_label: computerDispatch.label } : {}),
  })}\n\n`;

  if (computerDispatch) {
    // The selected computer gets the first and only claim path. This request
    // starts no model unless the queue-time policy explicitly opted into the
    // guarded workspace-API fallback and the availability clock fires.
    return followRunResponse({
      db,
      scope,
      runId: run.id,
      queue: true,
      windowMs: MAX_FOLLOW_MS,
      prelude,
      now,
      pollMs: args.pollMs,
      computerState: computerStateForTarget(scope),
      needDriver: args.computerFallbackDeps
        ? async (_activeRun: Run, fallbackReason?: WorkspaceApiFallbackReason | null) => {
            if (!fallbackReason) return;
            const fallbackDeps = args.computerFallbackDeps?.(fallbackReason);
            if (!fallbackDeps) return;
            // One immutable fallback session may drive only the row that
            // activated it. The follower asks again for the next queued row,
            // which rebuilds and validates that row's own API snapshot.
            await keep(driveConversation(fallbackDeps, conversation.id, { maxRuns: 1 }), `drive:fallback:${conversation.id}`);
          }
        : undefined,
    });
  }

  // Nothing is driving it: this request does. The driver is NOT tied to the response.
  const driving = driveConversation(deps, conversation.id);
  await keep(driving, `drive:${conversation.id}`);

  return followRunResponse({ db, scope, runId: run.id, queue: true, windowMs: MAX_FOLLOW_MS, prelude, now, pollMs: args.pollMs });
}
