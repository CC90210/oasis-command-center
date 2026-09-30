/** PUT /api/calendar/prefs — save the viewer's calendar settings. */

import { NextResponse } from "next/server";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { savePrefs } from "@/lib/calendar/store";
import { defaultPrefsFor } from "@/lib/calendar/types";
import { validatePrefs } from "@/lib/calendar/validate";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  // Keys the body leaves out come from the viewer's own workspace defaults.
  const prefs = validatePrefs(await readJson(req, 4_000), defaultPrefsFor(who.owner.tenantId));
  if (!prefs.ok) return badRequest(prefs.error);
  try {
    await savePrefs(who.owner, prefs.value);
    return NextResponse.json({ ok: true, prefs: prefs.value });
  } catch (err) {
    return errorResponse(err, "prefs");
  }
}
