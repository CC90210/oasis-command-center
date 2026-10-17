import { NextRequest, NextResponse } from "next/server";
import { BOOK_FORM_SLUG } from "@/lib/forms/public-booking-config";
import { publicBookingFormEnabled } from "@/lib/forms/public-booking";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { hostCalendarStatuses } from "@/lib/booking/host-calendar-status";
import type { BookingSettings } from "@/lib/booking/hours";
import { applyBookingSettingsEdit } from "@/lib/booking/settings-edit";
import {
  BookingSettingsError,
  bookingRoster,
  hostIdentities,
  loadBookingSettings,
  saveBookingSettings,
} from "@/lib/booking/settings-store";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { listCalendars } from "@/lib/calendar/store";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/calendar/booking - the Schedule's "Booking link" card.
 *
 * GET: the public link, whether it is live, the hosts with their hours, and the
 * signed-in person's own calendars (to choose where their booked calls land).
 * PUT {settings, expectedVersion}: save, compare-and-swap; only a host may save,
 * and each host chooses only their own target calendar (lib/booking/settings-edit.ts).
 *
 * OASIS only for now: the public booking engine serves the OASIS workspace.
 * Any other workspace gets { available: false } and the card is not drawn.
 */

/**
 * The settings as the signed-in person may see them: everyone's hours, but only
 * THEIR OWN target calendar id. Calendars are private to their owner; another
 * host's id is never sent (a save carries it over server-side, settings-edit.ts).
 */
function visibleSettings(settings: BookingSettings, viewerUserId: string): BookingSettings {
  return {
    ...settings,
    hosts: settings.hosts.map((host) => (host.userId === viewerUserId ? host : { ...host, targetCalendarId: null })),
  };
}

function settingsError(err: unknown, where: string): NextResponse {
  if (err instanceof BookingSettingsError) {
    console.error(`[calendar.booking.${where}]`, err.message);
    return NextResponse.json({ ok: false, error: err.code }, { status: 503 });
  }
  return errorResponse(err, `booking.${where}`);
}

export async function GET(): Promise<NextResponse> {
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;
  const { owner } = auth;
  if (owner.tenantId !== AI_AUDIT_TENANT_ID) return NextResponse.json({ ok: true, available: false });
  try {
    const [loaded, roster, calendars, live] = await Promise.all([
      loadBookingSettings(owner.tenantId),
      bookingRoster(owner.tenantId),
      listCalendars(owner, { create: false }),
      publicBookingFormEnabled(getServiceSupabase(), BOOK_FORM_SLUG),
    ]);
    const identities = hostIdentities(roster);
    // The same calendar read /book makes for each host, with each host's own
    // address (lib/booking/host-calendar-status.ts). A host whose calendar
    // cannot be read closes their on-duty slots; the card says why.
    const statuses = await hostCalendarStatuses({
      tenantId: owner.tenantId,
      hosts: loaded.settings.hosts,
      identities,
    });
    return NextResponse.json(
      {
        ok: true,
        available: true,
        path: "/book",
        live,
        version: loaded.version,
        saved: loaded.saved,
        settings: visibleSettings(loaded.settings, owner.userId),
        canEdit: loaded.settings.hosts.some((host) => host.userId === owner.userId),
        you: owner.userId,
        hosts: loaded.settings.hosts.map((host, index) => ({
          userId: host.userId,
          name: identities.get(host.userId)?.displayName ?? "Unknown teammate",
          role: host.role,
          calendar: statuses[index],
        })),
        roster: [...identities.values()].map((person) => ({ userId: person.userId, name: person.displayName })),
        calendars: calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, isDefault: calendar.isDefault })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return settingsError(err, "get");
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) return forbidden();
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;
  const { owner } = auth;
  if (owner.tenantId !== AI_AUDIT_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "booking_not_available" }, { status: 404 });
  }
  const body = (await readJson(req, 32_000)) as { settings?: unknown; expectedVersion?: unknown } | undefined;
  if (!body || typeof body !== "object") return badRequest("invalid_json");
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return badRequest("invalid_version");
  }
  try {
    const [loaded, roster, calendars] = await Promise.all([
      loadBookingSettings(owner.tenantId),
      bookingRoster(owner.tenantId),
      listCalendars(owner, { create: false }),
    ]);
    const edit = applyBookingSettingsEdit({
      current: loaded.settings,
      submitted: body.settings,
      callerUserId: owner.userId,
      rosterUserIds: new Set(hostIdentities(roster).keys()),
      callerCalendarIds: new Set(calendars.map((calendar) => calendar.id)),
    });
    if (!edit.ok) return NextResponse.json({ ok: false, error: edit.error }, { status: edit.status });
    const saved = await saveBookingSettings({
      tenantId: owner.tenantId,
      settings: edit.settings,
      expectedVersion,
      actorUserId: owner.userId,
    });
    if (!saved.ok) {
      return NextResponse.json({ ok: false, error: saved.error, version: saved.version }, { status: 409 });
    }
    return NextResponse.json({ ok: true, version: saved.version, settings: visibleSettings(edit.settings, owner.userId) });
  } catch (err) {
    return settingsError(err, "put");
  }
}
