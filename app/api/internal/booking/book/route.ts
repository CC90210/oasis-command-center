/**
 * POST /api/internal/booking/book - book a founder call for an agent outside the app (the Instagram DM setter), on the
 * same engine as /book: the Oasis Meet room, the Google invite, the Schedule copies, the pipeline move and the
 * sales-desk alert. Signed, never a session (lib/booking/agent-auth.ts); the same request_id replays. The work is
 * lib/booking/agent-booking.ts handleAgentBook.
 */
import { handleAgentBook } from "@/lib/booking/agent-booking";
import { liveAgentBookingDeps } from "@/lib/booking/agent-booking-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    return await handleAgentBook(req, liveAgentBookingDeps());
  } catch (err) {
    console.error("[booking-agent.book] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "booking_failed" }, { status: 500 });
  }
}
