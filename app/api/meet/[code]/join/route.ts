import type { NextRequest } from "next/server";
import { handleJoin } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/meet/[code]/join - enter a meeting: a name, the recording tick, a participant cookie (lib/meet/handlers.ts). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  return handleJoin(req, code, liveMeetDeps());
}
