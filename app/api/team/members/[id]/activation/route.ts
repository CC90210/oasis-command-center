/**
 * /api/team/members/<profileId>/activation — deactivate or reactivate a teammate.
 *
 *   GET   → what deactivating would do (lead counts per disposition, unpaid
 *           commission lines), so the confirm dialog states the consequences
 *           before anything changes.
 *   PATCH { active: false, reason? } → deactivate
 *   PATCH { active: true }           → reactivate
 *
 * True admins only (owner/admin base role), mirroring member removal. The
 * owner and the caller's own profile cannot be deactivated. All rules live in
 * lib/team-activation.ts; this file is only HTTP.
 */

import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getSessionContext } from "@/lib/team";
import {
  activationErrorStatus,
  deactivateMember,
  previewDeactivation,
  reactivateMember,
} from "@/lib/team-activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "activation_failed";
  const status = activationErrorStatus(error);
  if (status >= 500) console.error("[team.activation]", error);
  return bad(status, message);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) return bad(401, "unauthorized");
  const { id } = await ctx.params;
  if (!id) return bad(400, "missing id");
  try {
    const impact = await previewDeactivation({ tenantId: session.tenantId, targetProfileId: id, actor: session });
    return NextResponse.json({ ok: true, impact });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) return bad(401, "unauthorized");
  const { id } = await ctx.params;
  if (!id) return bad(400, "missing id");

  let body: { active?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }
  if (typeof body.active !== "boolean") return bad(400, "missing active");

  try {
    if (body.active) {
      const result = await reactivateMember({ tenantId: session.tenantId, targetProfileId: id, actor: session });
      return NextResponse.json({ ok: true, active: true, ...result });
    }
    const result = await deactivateMember({
      tenantId: session.tenantId,
      targetProfileId: id,
      actor: session,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return NextResponse.json({ ok: true, active: false, ...result });
  } catch (error) {
    return failure(error);
  }
}
