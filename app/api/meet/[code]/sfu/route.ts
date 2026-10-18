import type { NextRequest } from "next/server";
import { handleSfu } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/meet/[code]/sfu - one negotiation step on the caller's own Cloudflare Realtime session (lib/meet/handlers.ts). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  return handleSfu(req, code, liveMeetDeps());
}
