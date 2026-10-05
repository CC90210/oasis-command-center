/**
 * POST /api/calendar/events — apply a batch of event ops.
 *
 * Every event change goes through here, because one user action can be
 * several writes ("this and following" = create the new series, then end the
 * old one). Ops are validated as a whole before the first write, and the
 * Shabbat lock is enforced server-side on every create and update.
 */

import { NextResponse } from "next/server";
import { badRequest, errorResponse, forbidden, readJson, requireOwner, sameOrigin } from "@/lib/calendar/http";
import { applyOps, getPrefs } from "@/lib/calendar/store";
import { validateOps } from "@/lib/calendar/validate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbidden();
  const who = await requireOwner();
  if (!who.ok) return who.response;
  // 1 MB: room for a series plus its exceptions (LIMITS.opsPerBatch).
  const body = (await readJson(req, 1_000_000)) as { ops?: unknown } | undefined;
  if (!body) return badRequest("body_invalid");
  const ops = validateOps(body.ops);
  if (!ops.ok) return badRequest(ops.error);
  try {
    const prefs = await getPrefs(who.owner);
    const results = await applyOps(who.owner, ops.value, prefs);
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    return errorResponse(err, "events");
  }
}
