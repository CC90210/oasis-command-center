/**
 * PATCH  /api/calendar/calendars/:id — rename, recolour, show/hide.
 * DELETE /api/calendar/calendars/:id — remove a calendar and its events.
 */

import { NextResponse } from "next/server";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { deleteCalendar, updateCalendar } from "@/lib/calendar/store";
import { LIMITS, isColor, isId } from "@/lib/calendar/validate";
import type { CalendarRecord } from "@/lib/calendar/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  const { id } = await ctx.params;
  if (!isId(id)) return badRequest("id_invalid");
  const body = (await readJson(req, 4_000)) as Record<string, unknown> | undefined;
  if (!body) return badRequest("body_invalid");
  const patch: Partial<Pick<CalendarRecord, "name" | "color" | "visible">> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > LIMITS.calendarName) return badRequest("name_invalid");
    patch.name = name;
  }
  if (body.color !== undefined) {
    if (!isColor(body.color)) return badRequest("color_invalid");
    patch.color = body.color;
  }
  if (body.visible !== undefined) {
    if (typeof body.visible !== "boolean") return badRequest("visible_invalid");
    patch.visible = body.visible;
  }
  try {
    await updateCalendar(who.owner, id, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "calendars.update");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  const { id } = await ctx.params;
  if (!isId(id)) return badRequest("id_invalid");
  try {
    await deleteCalendar(who.owner, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "calendars.delete");
  }
}
