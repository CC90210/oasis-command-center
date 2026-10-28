import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { readRebookState } from "@/lib/booking/rebook";
import { RebookNotConfiguredError } from "@/lib/booking/rebook-token";
import {
  loadPublicBookingAvailability,
  publicBookingAvailabilitySchema,
  PUBLIC_BOOKING_TIME_ZONE,
  readPublicBookingJson,
} from "@/lib/forms/public-booking";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/forms/booking/rebook/slots {token}
 *
 * The open times for a missed meeting's rebook link (app/book/rebook/[token]),
 * at that meeting's own length and with its own host as organizer. A link that
 * cannot rebook answers its state instead of times, so the page can say why.
 * Only start instants are returned, never who is on a call.
 */
const SAFE_ERRORS = new Set([
  "public_booking_founders_unavailable",
  "google_calendar_not_connected",
  "calendar_scope_required",
  "calendar_organizer_mismatch",
  "calendar_availability_failed",
  "token_refresh_failed",
  "booking_settings_invalid",
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limit = rateLimit({ key: `public-rebook-slots:${getClientIp(req)}`, capacity: 20, refillPerSec: 1 / 6 });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }, { status: 429 });
  }
  const parsed = publicBookingAvailabilitySchema.safeParse(await readPublicBookingJson(req));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  try {
    const state = await readRebookState(getServiceSupabase(), parsed.data.token);
    if (state.state !== "open") {
      const error = state.state === "booked" ? "already_rebooked" : state.state === "pending" ? "rebook_in_progress" : "rebook_closed";
      return NextResponse.json({ ok: false, error }, { status: 409 });
    }
    const available = await loadPublicBookingAvailability({
      tenantId: state.claims.tenantId,
      durationMinutes: state.durationMinutes,
    });
    const host = state.appointment.assigned_to;
    const slots = available
      .filter((slot) => slot.hosts.some((h) => h.role === "organizer" && (!host || h.userId === host)))
      .map((slot) => slot.start);
    return NextResponse.json(
      { ok: true, slots, duration_minutes: state.durationMinutes, time_zone: PUBLIC_BOOKING_TIME_ZONE },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RebookNotConfiguredError) {
      console.error("[public-rebook.slots] rebook key not set");
      return NextResponse.json({ ok: false, error: "availability_unavailable" }, { status: 503 });
    }
    const raw = error instanceof Error ? error.message.split(":", 1)[0] : "";
    console.error("[public-rebook.slots]", error);
    return NextResponse.json({ ok: false, error: SAFE_ERRORS.has(raw) ? raw : "availability_unavailable" }, { status: 503 });
  }
}
