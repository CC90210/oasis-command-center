/**
 * POST /api/leads/[id]/promote — graduate a lead into the Applications pipeline.
 *
 * The Leads board and the Applications / Shop-Out boards are separate entity
 * types (lead vs application). A finished lead can't be shopped to funders until
 * a linked `application` record exists. This route is the explicit one-click
 * bridge surfaced by "Move to Applications" in the lead drawer: it creates (or
 * reuses) the application at status="application_in" so the deal shows up on the
 * Applications kanban + the Shop Out picker, and stamps the lead with the link
 * so the board can show a "Promoted →" badge.
 *
 * Reuses createApplicationFromLead (idempotent) — the same helper "Run
 * underwriting" already uses — so clicking twice never makes a duplicate. The
 * lead's own pipeline stage is intentionally left unchanged (predictable board).
 *
 * Auth: owner-or-admin OR the owning agent (getAccessibleLead, honors
 * LEAD_SCOPING_ENABLED); read-only members denied (parity with
 * /create-application); fail closed. Audited to lead_interactions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLead } from "@/lib/lead-access";
import { isReadOnlyRole } from "@/lib/role-gates";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { updateRecord } from "@/lib/manifest/data";

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
  // Member+ gate (parity with create-application). A read-only member can't
  // graduate a lead into the shoppable pipeline.
  if (isReadOnlyRole(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't move a lead to Applications." },
      { status: 403 },
    );
  }

  // Owner-or-admin gate + confirm the lead exists for this tenant. Returns 404
  // either way so a non-owner agent can't even probe for the record.
  const lead = await getAccessibleLead(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, entity: "lead", id: leadId },
  );
  if (!lead) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const result = await createApplicationFromLead({ tenantId: sess.tenantId, leadId });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  // Stamp the lead with the application link so the board shows "Promoted →" and
  // the back-reference is never lost. Best-effort: the application already links
  // back via data.lead_id, so a failed stamp doesn't break shopping.
  try {
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "lead",
      id: leadId,
      patch: { application_id: result.applicationId, promoted_at: new Date().toISOString() },
    });
  } catch {
    /* best-effort link stamp */
  }

  // Audit. Best-effort (mirrors /set-stage).
  try {
    const db = getServiceSupabase();
    const note = result.created
      ? `Promoted to Applications — application ${result.applicationId.slice(0, 8)} created (Application In)`
      : `Promoted to Applications — linked existing application ${result.applicationId.slice(0, 8)}`;
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      type: "promoted_to_application",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_promote",
      subject: "Promoted to Applications",
      content: note,
      content_preview: note,
      metadata: {
        application_id: result.applicationId,
        created: result.created,
        promoted_by: sess.userId,
      },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({
    ok: true,
    application_id: result.applicationId,
    created: result.created,
  });
}
