/**
 * POST /api/internal/booking/offers - the offer pages live right now, plus the booking page, for an agent outside
 * the app (the Instagram DM setter links only these). Signed, never a session (lib/booking/agent-auth.ts). The work is
 * lib/booking/agent-booking.ts handleAgentOffers.
 */
import { handleAgentOffers } from "@/lib/booking/agent-booking";
import { liveAgentBookingDeps } from "@/lib/booking/agent-booking-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    return await handleAgentOffers(req, liveAgentBookingDeps());
  } catch (err) {
    console.error("[booking-agent.offers] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "offers_failed" }, { status: 500 });
  }
}
