/**
 * /api/web-leads/[id]/objections/[eventId]
 *
 *   PATCH — attach the answer a rep actually used, or how the exchange ended,
 *     to an objection already logged. Body: { responseId?, usedVariant?,
 *     resolution? }. All three optional and independent: a rep may tap the
 *     objection and never resolve it, which is normal and must stay cheap.
 *
 * THE TENANT PIN LIVES ON THE UPDATE STATEMENT inside patchObjectionEvent, not
 * on a read here. A check performed before a separate write is a check a
 * concurrent request can slip past, so this route deliberately does NOT
 * read-then-write. THE LEAD PIN RIDES ON THE SAME STATEMENT, for the same
 * reason: `accessMode: "owned_oasis_sales"` is a per-lead ownership boundary,
 * so `eventId` must be proved to belong to the `id` in this URL, not merely to
 * this tenant.
 *
 * `authorize`, `leadMutationAccess` and `AuthorizedSession` below are repeated
 * verbatim from the sibling collection route (app/api/web-leads/[id]/objections/
 * route.ts) rather than shared. Step 5 of the build proved why: temporarily
 * changing `if (session.tenantId !== WEBDEV_TENANT_ID)` to `if (false)` and
 * running `npm run typecheck` still compiled clean -- nothing in the type
 * system catches a loosened tenant check, so a shared helper is a single
 * point a future edit to ONE caller could quietly weaken for every caller.
 * Verbatim duplication makes that class of edit visible in a diff of THIS
 * file instead of invisible in a shared module neither route author is
 * looking at.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { fetchLead, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { patchObjectionEvent, ObjectionEventError } from "@/lib/web-leads/objections/events";
import { isObjectionResolution } from "@/lib/web-leads/objections/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthorizedSession = Extract<Awaited<ReturnType<typeof resolveSessionContext>>, { ok: true }>;

function leadMutationAccess(session: AuthorizedSession, leadId: string) {
  return assertMayWorkLead({
    teamRole: session.teamRole,
    userId: session.userId,
    tenantId: WEBDEV_TENANT_ID,
    leadId,
    isOwner: session.isTrueAdmin,
    adminAccess: session.adminAccess,
    accessMode: "owned_oasis_sales",
  });
}

async function authorize(id: string) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: session.reason }, { status: 401 }) };
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  }
  const viewer: Viewer = { userId: session.userId, teamRole: session.teamRole, isAdmin: session.isAdmin };
  const lead = await fetchLead(id, viewer);
  if (!lead) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { ok: true as const, session, lead };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = await ctx.params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;

  if (!mayWorkWebsiteSalesLifecycle(auth.session.teamRole, auth.session.isAdmin)) {
    return NextResponse.json({ ok: false, error: "sales_role_required" }, { status: 403 });
  }
  const mutationAccess = await leadMutationAccess(auth.session, id);
  if (!mutationAccess.ok) {
    return NextResponse.json(
      { ok: false, error: mutationAccess.error, message: mutationAccess.message },
      { status: mutationAccess.status },
    );
  }

  let body: { responseId?: unknown; usedVariant?: unknown; resolution?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // `id` is the lead in this route's own URL, and it is what patchObjectionEvent
  // scopes the UPDATE to. authorize()/leadMutationAccess above prove the caller
  // may work THAT lead; without this the event was pinned only by tenant, so
  // lead A's owner could patch lead B's event by naming lead A in the path.
  const patch: Parameters<typeof patchObjectionEvent>[0] = { eventId, leadRecordId: id };
  if (body.responseId !== undefined) {
    if (typeof body.responseId !== "string" || !body.responseId.trim()) {
      return NextResponse.json({ ok: false, error: "invalid_response_id" }, { status: 400 });
    }
    // SHAPE ONLY. Whether this response is APPROVED and whether it belongs to
    // this event's own objection is proved inside patchObjectionEvent, on the
    // same statement as the write -- see its docblock. A check here would be a
    // check a concurrent request can slip past, and this route has no cheap way
    // to know the event's objection_id without the read-then-write it
    // deliberately avoids.
    patch.responseId = body.responseId.trim();
  }
  if (body.usedVariant !== undefined) patch.usedVariant = body.usedVariant === true;
  if (body.resolution !== undefined) {
    // A free-text resolution would make every Phase 3 lethality number quietly
    // wrong, so the closed set is enforced here as well as in the type.
    // ObjectionResolution is compile-time only -- nothing below this route
    // would otherwise stop a bad string reaching the UPDATE.
    if (!isObjectionResolution(body.resolution)) {
      return NextResponse.json({ ok: false, error: "invalid_resolution" }, { status: 400 });
    }
    patch.resolution = body.resolution;
  }

  try {
    const event = await patchObjectionEvent(patch);
    return NextResponse.json({ ok: true, event });
  } catch (err) {
    if (err instanceof ObjectionEventError) {
      // `unknown_response` is a 400, the same answer the sibling route's POST
      // gives for the same condition: the caller named a response that is not
      // an approved answer. A wrong response/objection PAIRING is not this
      // case -- it falls out of the UPDATE as not_found (404), so a response id
      // belonging to another objection cannot be distinguished from one that
      // does not exist. (Codex audit, P1.)
      const status =
        err.code === "not_found" ? 404
          : err.code === "empty_patch" || err.code === "unknown_response" ? 400
            : 500;
      return NextResponse.json({ ok: false, error: err.code }, { status });
    }
    console.error("[web-leads.objections] patch failed", {
      leadId: id,
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false, error: "objection_patch_failed" }, { status: 500 });
  }
}
