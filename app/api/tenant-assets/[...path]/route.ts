/**
 * GET /api/tenant-assets/<tenant>/<file> - a workspace's logo (and an offer
 * page's thumbnail), served from our own domain.
 *
 * Public (middleware PUBLIC_PATH_PREFIXES "/api/tenant-assets/"): a prospect on
 * a public form or offer page has no session, and the page's <img> must load.
 * Everything it refuses and why is in lib/tenant/tenant-asset-response.ts: only
 * the public tenant-assets prefix, only images, never another prefix.
 *
 * Rate-capped per address so the object store cannot be hammered through it; a
 * capped request gets the same empty 404 an <img> treats as "no logo".
 */
import { NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { tenantAssetResponse } from "@/lib/tenant/tenant-asset-response";
import { clientIpFromHeaders } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const resolved = clientIpFromHeaders(req.headers);
  const ip = resolved === "unknown" ? "no-ip" : resolved;
  if (!rateLimit({ key: `tenant-assets:${ip}`, capacity: 60, refillPerSec: 1 }).allowed) {
    return new Response(null, { status: 429, headers: { "cache-control": "no-store", "retry-after": "5" } });
  }
  const { path } = await ctx.params;
  return tenantAssetResponse(path ?? [], (bucket, key) => getServiceSupabase().storage.from(bucket).download(key));
}
