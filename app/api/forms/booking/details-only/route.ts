import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { sameOrigin } from "@/lib/calendar/http";
import { AI_AUDIT_ALERT_SOURCE } from "@/lib/forms/ai-audit-notify";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import { resolvePublicFunnelBooking } from "@/lib/forms/public-booking";
import { buildDetailsOnlyLeadAlert, type DetailsOnlyReason } from "@/lib/forms/public-booking-alert";
import { BOOK_FORM_SLUG } from "@/lib/forms/public-booking-config";
import { claimDetailsOnlyAlert } from "@/lib/forms/public-booking-details-only";
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
 * POST /api/forms/booking/details-only {token, reason}
 *
 * A /book visitor whose calendar would not load, or whose every open time was
 * taken, leaves details instead (components/booking/BookingPage.tsx). They
 * asked for a call and got none, so the sales desk hears about it once
 * (lib/forms/public-booking-details-only.ts). The lead's own signed form link
 * proves who it is; only the /book form's leads can raise it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "cross_origin_refused" }, { status: 403 });
  }
  const limit = rateLimit({ key: `public-booking-details-only:${getClientIp(req)}`, capacity: 4, refillPerSec: 1 / 60 });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as { token?: unknown; reason?: unknown } | null;
  const token = text(body?.token);
  if (!token || token.length > 4096) {
    return NextResponse.json({ ok: false, error: "invalid_booking_token" }, { status: 400 });
  }
  const reason: DetailsOnlyReason = body?.reason === "no_times" ? "no_times" : "calendar_error";

  const db = getServiceSupabase();
  let context: Awaited<ReturnType<typeof resolvePublicFunnelBooking>>;
  try {
    context = await resolvePublicFunnelBooking(db, token);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_booking_token" }, { status: 400 });
  }
  if (context.formSlug !== BOOK_FORM_SLUG) {
    return NextResponse.json({ ok: false, error: "not_a_book_lead" }, { status: 400 });
  }

  const claimed = await claimDetailsOnlyAlert(getTursoClient(), {
    tenantId: context.tenantId,
    leadId: context.leadId,
    now: new Date(),
  });
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
