import { type NextRequest, NextResponse } from "next/server";
import { bad } from "@/lib/api-helpers";
import { resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import { hasOnlyKeys, heartbeatRuntimeJob, isPlainObject, validRequestId } from "@/lib/bridge/runtime-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) {
  if (req.headers.get("origin")) return bad(403, "unexpected_origin_header");
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad(400, "body_must_be_json");
  }
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["lease_id"])) return bad(400, "unexpected_field");
  if (!validRequestId(body.lease_id)) return bad(400, "invalid_lease_id");
  const { job_id: jobId } = await ctx.params;
  if (!validRequestId(jobId)) return bad(400, "invalid_job_id");
  const result = await heartbeatRuntimeJob({
    tenantId: resolved.pairing.tenantId,
    pairingId: resolved.pairing.pairingId,
    jobId,
    leaseId: body.lease_id,
  });
  if (!result.ok) return bad(result.code === "pairing_revoked" || result.code === "pairing_not_approved" ? 403 : 409, result.code);
  return NextResponse.json({ ok: true, code: "lease_renewed", deadline_at: result.deadlineAt });
}
