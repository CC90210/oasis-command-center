/**
 * POST /api/scan/:id/claim — link the visitor's lead (its minted form token) to the scan and open
 * the AI audit engagement it continues as. The lead itself was created by POST /api/forms/submit.
 * Body: { token, claim_key } — the claim key came back from the POST /api/scan that started it.
 */
import { NextResponse } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { clientIpFromHeaders } from "@/lib/api-helpers";
import { readCappedJson, sameOrigin } from "@/lib/offer-pages/public-http";
import { rateLimit } from "@/lib/rate-limit";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { claimScan } from "@/lib/site-scan/claim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return json(404, { ok: false, error: "not_found" });
  if (!sameOrigin(req)) return json(403, { ok: false, error: "forbidden" });
  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit({ key: `site-scan:claim:${ip === "unknown" ? "no-ip" : ip}`, capacity: 10, refillPerSec: 10 / 3600 }).allowed) {
    return json(429, { ok: false, error: "rate_limited" });
  }
  const body = await readCappedJson(req, 8_192);
  const token = body && typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 2_048) return json(422, { ok: false, error: "token_required" });
  const claimKey = body && typeof body.claim_key === "string" ? body.claim_key.trim() : "";
  if (!claimKey || claimKey.length > 256) return json(403, { ok: false, error: "bad_claim_key" });
  if (!tursoConfigured()) return json(503, { ok: false, error: "not_installed" });
  const result = await claimScan(getTursoClient(), { tenantId: AI_AUDIT_TENANT_ID, scanId: id, token, claimKey, now: new Date() });
  if (!result.ok) {
    const status = result.error === "scan_not_found" || result.error === "lead_not_found" ? 404 : result.error === "claimed_by_another" ? 409 : 403;
    return json(status, { ok: false, error: result.error });
  }
  return json(200, { ok: true, engagement_id: result.engagementId, already_claimed: result.alreadyClaimed });
}
