/**
 * lib/tools/worker/index.ts - the tools that run inside the request that asked
 * for them, one executor per registry key with runsOn "worker".
 *
 * tests/tools-registry.test.ts holds this map and lib/tools/registry.ts to each
 * other: every worker tool has an executor here, and every executor here is a
 * registry tool that runs on the worker.
 *
 * An executor gets the CLEANED input (the registry validator's value), never
 * the request body, and the run's own context: the workspace, the person, the
 * run id. It answers a result or a code (lib/tools/errors.ts has the line);
 * one that throws is ended by the run handler as `tool_error`.
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { WorkerCommit } from "@/lib/tools/store";
import type { ToolModelDeps } from "@/lib/tools/worker/ai";
import { runLearnFromLink, type LearnInput, type PageFetch } from "@/lib/tools/worker/learn-from-link";
import { runRepurposePost } from "@/lib/tools/worker/repurpose-post";

export type WorkerContext = {
  db: Client;
  tenantId: string;
  userId: string | null;
  jobId: string;
  /** Who a written row names as its author (the person's email, else their profile). */
  contributedBy: string;
  now: () => Date;
  /** When THIS REQUEST started (set once in session-handlers.ts), not per-call: lib/tools/worker/ai.ts modelBudgetMs budgets the model call against what is left of the request, not a flat timer of its own. */
  requestStartedAt: Date;
  /** Tests inject these; production uses the real AI account path and fetch. */
  ai?: ToolModelDeps;
  fetchPage?: PageFetch;
};

export type WorkerResult =
  | { ok: true; result: unknown; commit?: WorkerCommit & { refusedCode: string } }
  | { ok: false; code: string };

export type WorkerExecutor = (input: Record<string, unknown>, ctx: WorkerContext) => Promise<WorkerResult>;

export const WORKER_EXECUTORS: Readonly<Record<string, WorkerExecutor>> = {
  repurpose_post: (input, ctx) =>
    runRepurposePost(
      { post: String(input.post ?? "") },
      { tenantId: ctx.tenantId, userId: ctx.userId, jobId: ctx.jobId, requestStartedAt: ctx.requestStartedAt },
      ctx.ai,
    ),
  learn_from_link: (input, ctx) => runLearnFromLink(input as unknown as LearnInput, ctx),
};
