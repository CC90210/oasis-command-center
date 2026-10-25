/** PUT /api/calendar/prefs — save the viewer's calendar settings. */

import { NextResponse } from "next/server";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { getPrefs, savePrefs } from "@/lib/calendar/store";
import { validatePrefs } from "@/lib/calendar/validate";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  const body = await readJson(req, 4_000);
  try {
    // Keys the body leaves out keep their SAVED value (a partial PUT is a patch), so an
    // API or agent caller can never reset a saved place or switch off an opted-in lock.
    const prefs = validatePrefs(body, await getPrefs(who.owner));
    if (!prefs.ok) return badRequest(prefs.error);
    await savePrefs(who.owner, prefs.value);
    return NextResponse.json({ ok: true, prefs: prefs.value });
  } catch (err) {
    return errorResponse(err, "prefs");
  }
}
