/**
 * GET /api/calendar — everything the Schedule page needs in one read:
 * the viewer's calendars, events and preferences. Private to the viewer.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/calendar/http";
import { getPrefs, listCalendars, listEvents } from "@/lib/calendar/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const who = await requireOwner();
  if (!who.ok) return who.response;
  try {
    const [calendars, { events, truncated }, prefs] = await Promise.all([
      listCalendars(who.owner),
      listEvents(who.owner),
      getPrefs(who.owner),
    ]);
    return NextResponse.json(
      { ok: true, calendars, events, truncated, prefs },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "read");
  }
}
