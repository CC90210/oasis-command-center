import { type NextRequest, NextResponse } from "next/server";
import { bad } from "@/lib/api-helpers";
import { resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import { failRuntimeJob, hasOnlyKeys, isFailureCode, isPlainObject, validRequestId } from "@/lib/bridge/runtime-jobs";

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
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["lease_id", "error"])) return bad(400, "unexpected_field");
  if (!validRequestId(body.lease_id)) return bad(400, "invalid_lease_id");
  if (!isPlainObject(body.error) || !hasOnlyKeys(body.error, ["code", "retryable"])) return bad(400, "unexpected_field");
  if (!isFailureCode(body.error.code)) return bad(400, "unsupported_failure_code");
  if (typeof body.error.retryable !== "boolean") return bad(400, "invalid_retryable");
  const { job_id: jobId } = await ctx.params;
  if (!validRequestId(jobId)) return bad(400, "invalid_job_id");
  const result = await failRuntimeJob({
    tenantId: resolved.pairing.tenantId,
    pairingId: resolved.pairing.pairingId,
    jobId,
    leaseId: body.lease_id,
    code: body.error.code,
    retryable: body.error.retryable,
  });
  if (!result.ok) {
    if (result.code === "pairing_revoked" || result.code === "pairing_not_approved" || result.code === "requester_seat_inactive") {
      return bad(403, result.code);
    }
    if (result.code === "lease_lost") return bad(409, result.code);
    return bad(400, result.code);
  }
  return NextResponse.json({ ok: true, code: "failed" });
}
