import type { NextRequest } from "next/server";
import { handleHost } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/meet/[code]/host - a host removes someone or ends the meeting; media is cut, not just tokens (lib/meet/handlers.ts). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  return handleHost(req, code, liveMeetDeps());
}
