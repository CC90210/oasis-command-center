import type { NextRequest } from "next/server";
import { handleState } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/meet/[code]/state - who is in the meeting and what they publish; polled by the room page (lib/meet/handlers.ts). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  return handleState(req, code, liveMeetDeps());
}
