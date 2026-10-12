import { type NextRequest, NextResponse } from "next/server";
import { bad } from "@/lib/api-helpers";
import { resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import { completeRuntimeJob, hasOnlyKeys, isPlainObject, validRequestId } from "@/lib/bridge/runtime-jobs";

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
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["lease_id", "result"])) return bad(400, "unexpected_field");
  if (!validRequestId(body.lease_id)) return bad(400, "invalid_lease_id");
  if (!isPlainObject(body.result) || typeof body.result.code !== "string") return bad(400, "invalid_result");
  const { code, ...resultBody } = body.result;
  const { job_id: jobId } = await ctx.params;
  if (!validRequestId(jobId)) return bad(400, "invalid_job_id");
  const result = await completeRuntimeJob({
    tenantId: resolved.pairing.tenantId,
    pairingId: resolved.pairing.pairingId,
    jobId,
    leaseId: body.lease_id,
    code,
    result: resultBody,
  });
  if (!result.ok) {
    if (result.code === "pairing_revoked" || result.code === "pairing_not_approved") return bad(403, result.code);
    if (result.code === "lease_lost") return bad(409, result.code);
    return bad(400, result.code);
  }
  return NextResponse.json({ ok: true, code: "completed" });
}
