import type { NextRequest } from "next/server";
import { handleCreateRoom, handleListRooms } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/calendar/meet - the Schedule's Meet panel: the workspace's meetings, and a new one (Start now,
 * or a link for later). Signed-in only: /api/calendar is not a public path, and the handler checks the session.
 */
export async function GET() {
  return handleListRooms(liveMeetDeps());
}

export async function POST(req: NextRequest) {
  return handleCreateRoom(req, liveMeetDeps());
}
