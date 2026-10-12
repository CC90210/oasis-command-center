/** Browser-only status. The session's tenant AND user id are predicates. */
import { type NextRequest, NextResponse } from "next/server";
import { bad } from "@/lib/api-helpers";
import { resolveSessionContext } from "@/lib/api-auth";
import { readRuntimeJobForOwner, validRequestId, type RuntimeJobRow } from "@/lib/bridge/runtime-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PublicStatus = "queued" | "claimed" | "running" | "waiting_user" | "done" | "failed";

function publicStatus(job: RuntimeJobRow): PublicStatus {
  if (job.status === "completed") return "done";
  if (job.status === "failed") return "failed";
  if (job.status === "running" && job.progressCode === "waiting_for_user") return "waiting_user";
  if (job.status === "running") return "running";
  // `claimed` is reserved in the public contract for a future two-phase
  // handoff. Today's store atomically moves queued -> running.
  return job.status === "queued" ? "queued" : "claimed";
}

function publicMessage(job: RuntimeJobRow, status: PublicStatus): string {
  if (status === "queued") return "Waiting for the selected computer.";
  if (status === "claimed") return "The selected computer claimed this job.";
  if (status === "waiting_user") return "Continue sign-in on the selected computer.";
  if (status === "done") return job.action === "auth" ? "Sign-in completed on the selected computer." : "The selected runtime answered successfully.";
  if (status === "failed") {
    const messages: Record<string, string> = {
      account_unsupported: "That account cannot be used by the selected runtime.",
      auth_process_failed: "The selected computer could not complete sign-in.",
      auth_start_failed: "The selected computer could not start sign-in.",
      auth_timeout: "Sign-in timed out on the selected computer.",
      cli_auth_required: "That AI app still needs sign-in on the selected computer.",
      cli_empty_output: "The selected AI app returned no answer.",
      cli_nonzero_exit: "The selected AI app stopped with an error.",
      cli_not_found: "That AI app is not installed on the selected computer.",
      cli_timeout: "The selected AI app did not answer in time.",
      manual_auth_required: "Continue sign-in on the selected computer.",
      runtime_action_failed: "The selected computer could not finish the runtime action.",
      runtime_engine_not_allowed: "That runtime is not allowed for this action.",
      runtime_probe_failed: "The selected runtime did not answer the test.",
      status_check_failed: "The selected computer could not check that runtime.",
      lease_expired: "The selected computer stopped responding before the action finished.",
    };
    return messages[job.errorCode ?? ""] ?? "The runtime action failed.";
  }
  const progress: Record<string, string> = {
    starting: "Starting on the selected computer.",
    authenticating: "Signing in on the selected computer.",
    probing: "Testing the selected runtime.",
    retrying: "Retrying on the selected computer.",
  };
  return progress[job.progressCode ?? ""] ?? "Running on the selected computer.";
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  const { job_id: jobId } = await ctx.params;
  if (!validRequestId(jobId)) return bad(400, "invalid_job_id");
  const job = await readRuntimeJobForOwner(session.tenantId, session.userId, jobId);
  if (!job) return bad(404, "runtime_job_not_found");
  const status = publicStatus(job);
  return NextResponse.json({
    ok: true,
    job: {
      id: job.id,
      status,
      action: job.action,
      engine: job.engine,
      errorCode: job.errorCode,
      message: publicMessage(job, status),
      result: job.result,
    },
  });
}
