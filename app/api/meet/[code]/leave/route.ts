import type { NextRequest } from "next/server";
import { handleLeave } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/meet/[code]/leave - leave the meeting; the caller's media is cut (lib/meet/handlers.ts). Also the page's unload beacon. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  return handleLeave(req, code, liveMeetDeps());
}
