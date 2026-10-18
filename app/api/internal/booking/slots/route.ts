/**
 * POST /api/internal/booking/slots - the open times /book offers, for an agent outside the app (the Instagram DM
 * setter on OASIS's PC). Signed, never a session: middleware lets /api/internal/booking/* through and the handler
 * authenticates first (lib/booking/agent-auth.ts). The work is lib/booking/agent-booking.ts handleAgentSlots.
 */
import { handleAgentSlots } from "@/lib/booking/agent-booking";
import { liveAgentBookingDeps } from "@/lib/booking/agent-booking-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    return await handleAgentSlots(req, liveAgentBookingDeps());
  } catch (err) {
    console.error("[booking-agent.slots] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "slots_failed" }, { status: 500 });
  }
}
