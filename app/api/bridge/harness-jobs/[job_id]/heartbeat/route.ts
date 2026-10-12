import { type NextRequest, NextResponse } from "next/server";
import { heartbeatHarnessJob } from "@/lib/bridge/harness-jobs";
import { authorizeHarnessProducer } from "@/lib/bridge/harness-jobs/producer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) {
  const { job_id: jobId } = await ctx.params;
  const authorized = await authorizeHarnessProducer(req, jobId);
  if (!authorized.ok) return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  const updated = await heartbeatHarnessJob({ tenantId: authorized.job.tenantId, jobId });
  return NextResponse.json(updated ? { ok: true } : { ok: false, error: "job_not_running" }, { status: updated ? 200 : 409 });
}
