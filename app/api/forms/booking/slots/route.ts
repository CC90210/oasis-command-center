import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { loadPublicBookingAvailability, PUBLIC_BOOKING_TIME_ZONE } from "@/lib/forms/public-booking";
import { isPublicBookingFormSlug, publicBookingDurationMinutes } from "@/lib/forms/public-booking-config";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/forms/booking/slots?form=book
 *
 * The open times of an OASIS booking form, BEFORE the visitor has typed
 * anything, so oasisai.work/book can lead with the calendar (CC, 2026-10-16).
 * No token: a slot start says nothing about any person. Only start instants
 * are returned, never who is on the call or why a time is closed. Booking
 * itself still needs the signed token the form's first step mints
 * (POST /api/forms/booking re-reads availability fresh before it books).
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limit = rateLimit({
    key: `public-booking-slots:${getClientIp(req)}`,
    capacity: 20,
    refillPerSec: 1 / 6,
  });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }, { status: 429 });
  }
  const formSlug = (req.nextUrl.searchParams.get("form") || "").trim().toLowerCase();
  if (!formSlug || formSlug.length > 64 || !isPublicBookingFormSlug(formSlug)) {
    return NextResponse.json({ ok: false, error: "booking_form_not_found" }, { status: 404 });
  }
  try {
    const form = await getServiceSupabase()
      .from("forms")
      .select("id,enabled")
      .eq("tenant_id", AI_AUDIT_TENANT_ID)
      .eq("slug", formSlug)
      .maybeSingle();
    if (form.error) throw new Error(`booking_form_read_failed:${form.error.message}`);
    const row = form.data as { id?: string; enabled?: unknown } | null;
    if (!row?.id || !(row.enabled === true || row.enabled === 1)) {
      return NextResponse.json({ ok: false, error: "booking_form_not_found" }, { status: 404 });
    }
    const durationMinutes = publicBookingDurationMinutes(formSlug);
    const available = await loadPublicBookingAvailability({ tenantId: AI_AUDIT_TENANT_ID, durationMinutes });
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
    const raw = error instanceof Error ? error.message.split(":", 1)[0] : "";
    const code = SAFE_ERRORS.has(raw) ? raw : "availability_unavailable";
    console.error("[public-booking.slots]", error);
    return NextResponse.json({ ok: false, error: code }, { status: 503 });
  }
}
