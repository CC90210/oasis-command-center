/**
 * POST /api/leads/[id]/decline — DECLINE a lead.
 *
 * `declined` is not a valid LEAD stage (it lives on the Applications board), so a lead
 * is declined by becoming a promoted application with status="declined" → it lands in
 * Applications › Declined. Core logic lives in lib/applications/decline-lead.ts, shared
 * with the bulk route's op:"decline".
 *
 * Idempotent: re-declining reuses the same application. Auth: any non-read_only tenant
 * member (getWritableLead / canWriteCrm); read-only denied; fail closed. Audited.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { declineLeadToApplication } from "@/lib/applications/decline-lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const acc = await getWritableLead(
    { teamRole: sess.teamRole },
    { tenantId: sess.tenantId, entity: "lead", id: leadId },
  );
  if (!acc.ok) {
    return acc.reason === "role_denied"
      ? NextResponse.json(
          { ok: false, error: "forbidden_role", message: "Read-only members can't do this." },
          { status: 403 },
        )
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const dec = await declineLeadToApplication({
    tenantId: sess.tenantId,
    leadId,
    leadData: acc.record.data as Record<string, unknown>,
  });
  if (!dec.ok) {
    return NextResponse.json({ ok: false, error: dec.error }, { status: 500 });
  }
  const appId = dec.applicationId;

  // Audit (best-effort, mirrors /promote + /set-stage).
  try {
    const db = getServiceSupabase();
    const note = `Declined from the leads board → Applications › Declined (application ${appId.slice(0, 8)})`;
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      type: "stage_changed",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_decline",
      subject: "Declined",
      content: note,
      content_preview: note,
      metadata: { application_id: appId, declined_by: sess.userId, from: "leads_board" },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({ ok: true, application_id: appId });
}
