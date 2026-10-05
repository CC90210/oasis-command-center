/**
 * POST /api/leads/[id]/stage-event — common communication-event trigger.
 *
 * Lets non-server-rendered communication surfaces report an outbound send or
 * a signed form without re-implementing the tenant-aware rule lookup.
 *
 * OASIS qualification, booking, proposal, payment, and delivery transitions
 * are not exposed here; they require the structured website-sales workflow.
 *
 * Body: { type: "outbound_email_sent" | "outbound_email_queued" |
 *                "form_signed" }
 *
 * Auth: session-cookie → tenant.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMON_OPERATOR_TRIGGERABLE = new Set<string>([
  "outbound_email_sent",
  "outbound_email_queued",
  "form_signed",
]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let body: { type?: unknown };
  try {
    body = (await req.json()) as { type?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const type = typeof body.type === "string" ? body.type : "";
  if (!COMMON_OPERATOR_TRIGGERABLE.has(type)) {
    return NextResponse.json(
      { ok: false, error: "event_type_not_allowed", type },
      { status: 400 },
    );
  }

  const tenantSlug = await resolveOwnedSlug(sess.tenantId);
  if (!tenantSlug) {
    return NextResponse.json({ ok: false, error: "tenant_scope_unresolved" }, { status: 500 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: isWebsiteSalesTenantSlug(tenantSlug) ? "owned_oasis_sales" : "crm",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }

  const result = await dispatchLeadStageEvent({
    type: type as "outbound_email_sent" | "outbound_email_queued" | "form_signed",
    tenantId: sess.tenantId,
    leadId,
  });

  // Cache invalidation moved into the dispatcher (lib/lead-stage-
  // dispatcher.ts) so every caller — API route or webhook —
  // webhook — refreshes the operator's kanban + lead detail + tenant
  // shell on a successful fire.

  return NextResponse.json({
    ok: true,
    fired: result.fired,
    ...(result.fired
      ? { from: result.from, to: result.to, reason: result.reasonCode }
      : { reason: result.reason }),
  });
}
