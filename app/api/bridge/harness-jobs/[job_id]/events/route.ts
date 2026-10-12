import { type NextRequest, NextResponse } from "next/server";
import { appendHarnessEvents, isPlainObject } from "@/lib/bridge/harness-jobs";
import { authorizeHarnessProducer } from "@/lib/bridge/harness-jobs/producer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) {
  const { job_id: jobId } = await ctx.params;
  const authorized = await authorizeHarnessProducer(req, jobId);
  if (!authorized.ok) return json(authorized.status, { ok: false, error: authorized.error });
  const raw = await req.text();
  if (raw.length > 256_000) return json(413, { ok: false, error: "batch_too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "events") || !Array.isArray(body.events)) {
    return json(400, { ok: false, error: "events_invalid" });
  }
  const result = await appendHarnessEvents({ tenantId: authorized.job.tenantId, jobId, events: body.events });
  return result.ok ? json(200, { ok: true, terminal: result.terminal }) : json(409, { ok: false, error: result.code });
}
