/** POST /api/calendar/calendars — create a calendar for the viewer. */

import { NextResponse } from "next/server";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { createCalendar } from "@/lib/calendar/store";
import { LIMITS, isColor } from "@/lib/calendar/validate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  const body = (await readJson(req, 4_000)) as { name?: unknown; color?: unknown } | undefined;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > LIMITS.calendarName) return badRequest("name_invalid");
  if (!isColor(body?.color)) return badRequest("color_invalid");
  try {
    const calendar = await createCalendar(who.owner, { name, color: body.color });
    return NextResponse.json({ ok: true, calendar });
  } catch (err) {
    return errorResponse(err, "calendars.create");
  }
}
