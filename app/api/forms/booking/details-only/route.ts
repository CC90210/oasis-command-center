import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { sameOrigin } from "@/lib/calendar/http";
import { AI_AUDIT_ALERT_SOURCE, bookedCallFromAppointment } from "@/lib/forms/ai-audit-notify";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import {
  publicBookingDetailsOnlySchema,
  readPublicBookingJson,
  resolvePublicFunnelBooking,
} from "@/lib/forms/public-booking";
import { buildDetailsOnlyLeadAlert, type DetailsOnlyReason } from "@/lib/forms/public-booking-alert";
import { BOOK_FORM_SLUG } from "@/lib/forms/public-booking-config";
import {
  claimDetailsOnlyAlert,
  claimDetailsOnlyAlertLegacy,
  tursoHoldsTheLeads,
} from "@/lib/forms/public-booking-details-only";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolution failures a retry cannot change: a bad or expired link, no such
 * form or lead, a form not filled in. Anything else (a read that failed) is
 * answered 503 so the page's retry tries again (Codex review of #677), the
 * same split the booking route makes.
 */
const FINAL_RESOLUTION_ERRORS = new Set(["booking_form_not_found", "booking_form_not_completed", "booking_lead_not_found"]);

function resolutionIsFinal(error: unknown): boolean {
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
  return code.startsWith("token_") || FINAL_RESOLUTION_ERRORS.has(code);
}

/** The lead's referenced call is live: scheduled, verified and in the future (bookedCallFromAppointment). */
async function holdsLiveCall(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  leadId: string,
  appointmentId: string,
): Promise<boolean> {
  if (!appointmentId) return false;
  try {
    const appt = await db
      .from("call_appointments")
      .select("scheduled_for,status,calendar_status")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("id", appointmentId)
      .maybeSingle();
    return !appt.error && Boolean(bookedCallFromAppointment(appt.data as Parameters<typeof bookedCallFromAppointment>[0]));
  } catch (error) {
    console.error("[public-booking.details-only.appointment]", error);
    return false;
  }
}

/**
 * POST /api/forms/booking/details-only {token, reason}
 *
 * A /book visitor whose calendar would not load, or whose every open time was
 * taken, leaves details instead (components/booking/BookingPage.tsx). They
 * asked for a call and got none, so the sales desk hears about it, at most
 * once a day per lead and never for a lead holding a live call
 * (lib/forms/public-booking-details-only.ts). The lead's own signed form link
 * proves who it is; only the /book form's leads can raise it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "cross_origin_refused" }, { status: 403 });
  }
  // The same budget the form gives a new visitor (forms-anon-init in the submit
  // route): one connection that can submit /book can raise its alert, and a
  // refill every 6 s is inside the page's retry backoff (Codex review of #677).
  const limit = rateLimit({ key: `public-booking-details-only:${getClientIp(req)}`, capacity: 10, refillPerSec: 10 / 60 });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }, { status: 429 });
  }
  // The booking routes' own capped reader and strict shape: an anonymous body
  // is read through an 8 KB cap and must hold exactly these two fields (Codex
  // review of #677).
  const parsed = publicBookingDetailsOnlySchema.safeParse(await readPublicBookingJson(req));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const token = parsed.data.token;
  const reason = parsed.data.reason as DetailsOnlyReason;

  const db = getServiceSupabase();
  let context: Awaited<ReturnType<typeof resolvePublicFunnelBooking>>;
  try {
    context = await resolvePublicFunnelBooking(db, token);
  } catch (error) {
    if (resolutionIsFinal(error)) {
      return NextResponse.json({ ok: false, error: "invalid_booking_token" }, { status: 400 });
    }
    console.error("[public-booking.details-only.resolve]", error);
    return NextResponse.json({ ok: false, error: "booking_unavailable" }, { status: 503 });
  }
  if (context.formSlug !== BOOK_FORM_SLUG) {
    return NextResponse.json({ ok: false, error: "not_a_book_lead" }, { status: 400 });
  }

  // A lead who holds a live call (scheduled, verified, in the future) is not
  // waiting. Judged on the appointment, not on the lead's appointment id: a
  // past or cancelled call leaves its id behind (Codex review of #677). A read
  // that fails counts as not booked: an extra alert beats a lost one.
  if (await holdsLiveCall(db, context.tenantId, context.leadId, text(context.lead.calendar_appointment_id))) {
    return NextResponse.json({ ok: true, alerted: false });
  }

  // Claimed on whichever store holds the leads: Turso, or Supabase on a rolled-back deploy.
  const claim = { tenantId: context.tenantId, leadId: context.leadId, now: new Date() };
  const claimed = tursoHoldsTheLeads()
    ? await claimDetailsOnlyAlert(getTursoClient(), claim)
    : await claimDetailsOnlyAlertLegacy(db, { ...claim, lead: context.lead });
  if (!claimed) return NextResponse.json({ ok: true, alerted: false });

  const combined = { ...context.answers, ...context.lead };
  const sent = await pushWorkspaceAlert(
    context.tenantId,
    buildDetailsOnlyLeadAlert({
      offerName: context.formName,
      name: text(combined.name),
      company: text(combined.company_name) || text(combined.company),
      reason,
      leadUrl: pipelineLeadUrl(context.leadId),
    }),
    { desk: "sales" },
  );
  if (!sent.delivered) {
    await recordAlertFailure({
      db,
      tenantId: context.tenantId,
      leadId: context.leadId,
      source: AI_AUDIT_ALERT_SOURCE,
      label: `${context.formName} (details only)`,
      reason: sent.outcome,
      extra: "They asked for a call and could not pick a time.",
      tag: "public-booking.details-only.telegram",
    });
  }
  return NextResponse.json({ ok: true, alerted: true });
}
