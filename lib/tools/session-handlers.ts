/**
 * lib/tools/session-handlers.ts - the two routes a signed-in person's Tools
 * section calls, as handlers taking their dependencies so tests run them with a
 * real session and a local database:
 *
 *   POST /api/tools/run    {"tool","input","idempotency_key"}: run a tool, or
 *                          queue it for the runner
 *   GET  /api/tools/jobs   ?tool=<key>&limit=5 (newest first) or ?id=<job id>
 *
 * Who: lib/tools/access.ts resolveToolsViewer, the one gate. Anyone else gets
 * 404 not_found (never 403). Every read and write is the viewer's workspace;
 * a job id from another workspace is "not found". A tool marked operatorOnly
 * in the registry (Learn from a link: agent-harness training material) is
 * refused the same way to a founder who passed that gate but is not a
 * verified platform operator (refusedToNonOperator, below).
 *
 * A worker tool runs inside this request and the answer carries the finished
 * run; a tool that FAILED is still a 200, the failure is in the run (its code
 * and plain line). A runner tool is queued, only while a runner that serves
 * this workspace was seen in the last 10 minutes, at most five at once, and a
 * link already being downloaded answers that run instead of a second one.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { SWEEP_ERROR_LINES } from "@/lib/tools/errors";
import { toolByKey, type ToolDef } from "@/lib/tools/registry";
import type { ToolsViewer } from "@/lib/tools/access";
import { removeUnusedUploads, type ToolStorage } from "@/lib/tools/runner-handlers";
import {
  finishWorkerJob,
  findByIdempotencyKey,
  findInflightByDedupe,
  getJob,
  inputHashOf,
  insertJob,
  jobView,
  listJobs,
  liveRunnerForTool,
  newJobId,
  sweepToolJobs,
  toolTablesInstalled,
  type ToolJob,
} from "@/lib/tools/store";
// Types only: the executors (and the fetcher and model code under them) are
// loaded inside runWorker, so the jobs route, polled every 3 s, never loads them.
import type { WorkerContext, WorkerResult } from "@/lib/tools/worker";

export type SessionDeps = {
  db: Client;
  now: () => Date;
  viewer: () => Promise<ToolsViewer | null>;
  /** Tests inject the model and the fetch; production uses the real ones. */
  worker?: Pick<WorkerContext, "ai" | "fetchPage">;
  /** The object store, for deleting uploads a sweep left behind. */
  storage?: () => Promise<ToolStorage | null>;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST = 20;
const DEFAULT_LIST = 5;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
const notFound = () => json(404, { ok: false, error: "not_found" });
const notSetUp = () => json(503, { ok: false, error: "not_set_up", message: "Tools are not set up yet." });

/**
 * True when `tool` is operatorOnly (lib/tools/registry.ts) and `viewer` is not
 * a verified platform operator (lib/platform-operator.ts - auth-user-verified,
 * never an email string). A founder who passed the Toolkit's own gate above is
 * refused here just the same: operatorOnly means OASIS operators, not every
 * founder of the workspace an operator happens to also run.
 */
async function refusedToNonOperator(tool: Pick<ToolDef, "operatorOnly">, viewer: ToolsViewer): Promise<boolean> {
  if (!tool.operatorOnly) return false;
  const check = await resolvePlatformOperatorForAuthUser(viewer.userId, viewer.email);
  return !check.operator;
}

async function sweepFor(deps: SessionDeps, tenantId: string): Promise<void> {
  const swept = await sweepToolJobs(deps.db, [tenantId], deps.now());
  if (!swept.orphanUploads.length || !deps.storage) return;
  const storage = await deps.storage().catch(() => null);
  // The same delete the runner routes use: only a path under the job's own workspace.
  await removeUnusedUploads(storage, swept.orphanUploads, "jobs.sweep");
}

// ---------------------------------------------------------------------------
// POST /api/tools/run
// ---------------------------------------------------------------------------

export async function handleToolRun(req: Request, deps: SessionDeps): Promise<Response> {
  const viewer = await deps.viewer();
  if (!viewer) return notFound();

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { ok: false, error: "invalid_json" });
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  if (!(await toolTablesInstalled(deps.db))) return notSetUp();
  const tool = toolByKey(body.tool);
  if (!tool) return json(422, { ok: false, error: "unknown_tool" });
  if (await refusedToNonOperator(tool, viewer)) return notFound();
  const key = body.idempotency_key;
  if (typeof key !== "string" || !UUID_V4.test(key)) {
    return json(422, { ok: false, error: "invalid_input", field: "idempotency_key", code: "invalid" });
  }
  const v = tool.validate(body.input);
  if (!v.ok) return json(422, { ok: false, error: "invalid_input", field: v.field, code: v.code });

  const tenantId = viewer.tenantId;
  const inputHash = inputHashOf(tool.key, v.value);
  await sweepFor(deps, tenantId);

  // The same click arriving twice is one run; the same key for something else is a client bug.
  const again = await sameKey(deps.db, tenantId, key, inputHash);
  if (again) return again;

  if (tool.runsOn === "runner") {
    if (!(await liveRunnerForTool(deps.db, tenantId, tool.key, deps.now()))) {
      return json(409, { ok: false, error: "runner_offline", message: SWEEP_ERROR_LINES.runner_offline });
    }
  }
  if (v.dedupeKey) {
    const inflight = await findInflightByDedupe(deps.db, tenantId, v.dedupeKey);
    if (inflight) return json(200, { ok: true, job: jobView(inflight), reused: true });
  }

  const jobId = newJobId();
  let inserted: "inserted" | "full";
  try {
    inserted = await insertJob(
      deps.db,
      {
        id: jobId,
        tenantId,
        toolKey: tool.key,
        runsOn: tool.runsOn,
        input: v.value,
        inputHash,
        idempotencyKey: key,
        dedupeKey: v.dedupeKey,
        createdBy: viewer.profileId,
        createdByEmail: viewer.email,
      },
      deps.now(),
    );
  } catch (err) {
    if (!isUniqueViolationError(err as { message?: string })) throw err;
    // Lost a race with the same click, or with the same link already in flight.
    const raced = (await sameKey(deps.db, tenantId, key, inputHash)) ?? (await reuseInflight(deps.db, tenantId, v.dedupeKey));
    if (raced) return raced;
    throw err;
  }
  if (inserted === "full") {
    return json(429, { ok: false, error: "too_many_in_flight", message: "Five downloads are already in progress." });
  }
  if (tool.runsOn === "runner") return json(200, { ok: true, job: jobView((await getJob(deps.db, tenantId, jobId)) as ToolJob) });

  await runWorker(tool, v.value, jobId, viewer, deps);
  const job = await getJob(deps.db, tenantId, jobId);
  return json(200, { ok: true, job: job ? jobView(job) : null });
}

async function sameKey(db: Client, tenantId: string, key: string, inputHash: string): Promise<Response | null> {
  const existing = await findByIdempotencyKey(db, tenantId, key);
  if (!existing) return null;
  if (existing.inputHash !== inputHash) return json(409, { ok: false, error: "idempotency_key_reused" });
  return json(200, { ok: true, job: jobView(existing) });
}

async function reuseInflight(db: Client, tenantId: string, dedupeKey: string | null): Promise<Response | null> {
  if (!dedupeKey) return null;
  const inflight = await findInflightByDedupe(db, tenantId, dedupeKey);
  return inflight ? json(200, { ok: true, job: jobView(inflight), reused: true }) : null;
}

/** Run a worker tool to its end, inside this request. Every path leaves the run done or failed. */
async function runWorker(tool: ToolDef, input: Record<string, unknown>, jobId: string, viewer: ToolsViewer, deps: SessionDeps): Promise<void> {
  let outcome: WorkerResult;
  try {
    const { WORKER_EXECUTORS } = await import("@/lib/tools/worker");
    const exec = WORKER_EXECUTORS[tool.key];
    if (!exec) throw new Error(`no executor for ${tool.key}`);
    outcome = await exec(input, {
      db: deps.db,
      tenantId: viewer.tenantId,
      userId: viewer.userId,
      jobId,
      contributedBy: viewer.email || `profile:${viewer.profileId}`,
      now: deps.now,
      ai: deps.worker?.ai,
      fetchPage: deps.worker?.fetchPage,
    });
  } catch (err) {
    console.error("[tools.run] the tool threw", { tool: tool.key, jobId, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    outcome = { ok: false, code: "tool_error" };
  }
  if (!outcome.ok) {
    await finishWorkerJob(deps.db, viewer.tenantId, jobId, outcome, deps.now());
    return;
  }
  const done = await finishWorkerJob(deps.db, viewer.tenantId, jobId, { ok: true, result: outcome.result }, deps.now(), outcome.commit);
  // The run's own write was refused (a read of this link started meanwhile):
  // the run is still running, so it ends with that write's code.
  if (!done && outcome.commit) {
    await finishWorkerJob(deps.db, viewer.tenantId, jobId, { ok: false, code: outcome.commit.refusedCode }, deps.now());
  }
}

// ---------------------------------------------------------------------------
// GET /api/tools/jobs
// ---------------------------------------------------------------------------

export async function handleToolJobs(req: Request, deps: SessionDeps): Promise<Response> {
  const viewer = await deps.viewer();
  if (!viewer) return notFound();
  if (!(await toolTablesInstalled(deps.db))) return notSetUp();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const toolParam = url.searchParams.get("tool");
  if (!id && !toolParam) return json(422, { ok: false, error: "invalid_input", field: "tool", code: "required" });

  await sweepFor(deps, viewer.tenantId);
  if (id) {
    if (!JOB_ID.test(id)) return notFound();
    const job = await getJob(deps.db, viewer.tenantId, id);
    if (!job) return notFound();
    const jobTool = toolByKey(job.toolKey);
    if (jobTool && (await refusedToNonOperator(jobTool, viewer))) return notFound();
    return json(200, { ok: true, job: jobView(job) });
  }
  const tool = toolByKey(toolParam);
  if (!tool) return json(422, { ok: false, error: "unknown_tool" });
  if (await refusedToNonOperator(tool, viewer)) return notFound();
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIST);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, MAX_LIST) : DEFAULT_LIST;
  const jobs = await listJobs(deps.db, viewer.tenantId, tool.key, limit);
  return json(200, { ok: true, jobs: jobs.map(jobView) });
}
