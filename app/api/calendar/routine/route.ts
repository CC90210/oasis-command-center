/**
 * /api/calendar/routine — restore the weekly routine the old Schedule page
 * showed (lib/schedule/model.ts createPlaceholderSchedule) as repeating
 * events in the viewer's own default calendar.
 *
 *   GET   whether the viewer can restore it, whether it is already there, and
 *         the blocks and times it would write (for the restore card).
 *   POST  writes it, once. The body may carry `times` (the card's "Edit
 *         times"): new start/end minutes for known blocks only. A second call
 *         answers { status: "already_restored" } and writes nothing.
 *
 * OASIS only. The routine is OASIS's own (client fulfillment, internal
 * systems, agent R&D), so a client workspace is told it is not available and
 * is never shown the blocks. The owner is the session user and their session
 * workspace; nothing in the request can name another.
 */

import { NextResponse } from "next/server";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { applyRoutineTimes, ROUTINE_TIME_ZONE, routineBlocks, SHABBAT_WIND_DOWN_MIN } from "@/lib/calendar/routine";
import { countRoutineEvents, restoreRoutine } from "@/lib/calendar/store";
import { OASIS_HOME_TENANT_ID } from "@/lib/calendar/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET() {
  const who = await requireOwner();
  if (!who.ok) return who.response;
  if (who.owner.tenantId !== OASIS_HOME_TENANT_ID) {
    return NextResponse.json({ ok: true, available: false }, { headers: NO_STORE });
  }
  try {
    const existing = await countRoutineEvents(who.owner);
    return NextResponse.json(
      {
        ok: true,
        available: true,
        restored: existing > 0,
        timeZone: ROUTINE_TIME_ZONE,
        windDownMinutes: SHABBAT_WIND_DOWN_MIN,
        blocks: routineBlocks(),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return errorResponse(err, "routine.read");
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  if (who.owner.tenantId !== OASIS_HOME_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "routine_not_available" }, { status: 403 });
  }
  const body = (await readJson(req, 8_000)) as { times?: unknown } | undefined;
  if (!body || typeof body !== "object") return badRequest("body_invalid");
  const blocks = applyRoutineTimes(routineBlocks(), body.times);
  if (!blocks.ok) return badRequest(blocks.error);
  try {
    const result = await restoreRoutine(who.owner, { blocks: blocks.value, now: new Date() });
    return NextResponse.json({ ok: true, ...result }, { status: result.status === "restored" ? 201 : 200 });
  } catch (err) {
    return errorResponse(err, "routine");
  }
}
