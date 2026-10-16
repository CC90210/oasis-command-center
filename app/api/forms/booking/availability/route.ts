import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { sameOrigin } from "@/lib/calendar/http";
import {
  isPublicBookingStageBookable,
  loadPublicBookingAvailability,
  publicBookingAvailabilitySchema,
  PUBLIC_BOOKING_TIME_ZONE,
  readPublicBookingJson,
  resolvePublicFunnelBooking,
} from "@/lib/forms/public-booking";
import { publicBookingDurationMinutes } from "@/lib/forms/public-booking-config";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_AVAILABILITY_ERRORS = new Set([
  "booking_form_not_found",
  "booking_form_not_completed",
  "booking_submission_read_failed",
  "booking_lead_not_found",
  "public_booking_founders_unavailable",
  "google_calendar_not_connected",
  "calendar_scope_required",
  "calendar_organizer_mismatch",
  "calendar_availability_failed",
  "token_refresh_failed",
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "cross_origin_refused" }, { status: 403 });
  }
  const limit = rateLimit({
    key: `public-booking-availability:${getClientIp(req)}`,
    capacity: 20,
    refillPerSec: 1 / 10,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }
  const parsed = publicBookingAvailabilitySchema.safeParse(await readPublicBookingJson(req));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  try {
    const context = await resolvePublicFunnelBooking(getServiceSupabase(), parsed.data.token);
    if (typeof context.lead.calendar_appointment_id === "string" && context.lead.calendar_appointment_id) {
      return NextResponse.json({ ok: false, error: "already_booked" }, { status: 409 });
    }
    // The booking endpoint refuses a lead past the founder handoff. Say so HERE,
    // before reading two calendars, instead of showing slots no selection can book.
    if (!isPublicBookingStageBookable(context.lead.stage)) {
      return NextResponse.json({ ok: false, error: "lead_stage_not_bookable" }, { status: 409 });
    }
    const durationMinutes = publicBookingDurationMinutes(context.formSlug);
    const available = await loadPublicBookingAvailability({
      tenantId: context.tenantId,
      durationMinutes,
    });
    return NextResponse.json(
      {
        ok: true,
        slots: available.map((slot) => slot.start),
        duration_minutes: durationMinutes,
        time_zone: PUBLIC_BOOKING_TIME_ZONE,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const rawCode = error instanceof Error ? error.message.split(":", 1)[0] : "";
    const code = rawCode.startsWith("token_")
      ? "invalid_booking_token"
      : SAFE_AVAILABILITY_ERRORS.has(rawCode)
        ? rawCode
        : "availability_unavailable";
    const status = code === "invalid_booking_token" || code === "booking_form_not_completed"
      ? 400
      : code.includes("not_found")
        ? 404
        : 503;
    if (status >= 500) console.error("[public-booking.availability]", error);
    return NextResponse.json({ ok: false, error: code }, { status });
  }
}
