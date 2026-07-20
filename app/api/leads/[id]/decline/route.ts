/**
 * POST /api/leads/[id]/decline — DECLINE a lead.
 *
 * `declined` is no longer a valid LEAD stage (moved OFF the leads board to the
 * Applications board 2026-07-15), so a lead can only be "declined" by becoming a
 * promoted application with status="declined". This route does that atomically:
 *   1. creates (or reuses) the linked application (createApplicationFromLead — the
 *      same helper /promote + "Run underwriting" use, so no duplicate is made),
 *   2. sets that application's status="declined" + backfills identity from the lead,
 *   3. stamps promoted_at (application → Applications board) then transferred_at
 *      (lead → off the leads board), so the deal lands in exactly one place:
 *      Applications › Declined.
 *
 * Mirrors /promote but lands at "declined" instead of "application_in".
 * Idempotent: re-declining reuses the same application. Auth: any non-read_only
 * tenant member (getWritableLead / canWriteCrm); read-only denied; fail closed. Audited.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { getRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { extractAppFields } from "@/lib/forms/application-upsert";

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
  // Role-based CRM-write gate (canWriteCrm / getWritableLead). Denies read_only
  // regardless of LEAD_SCOPING_ENABLED so any full member can decline any lead.
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
  const lead = acc.record;

  // 1. Create or reuse the linked application (idempotent — never duplicates).
  const result = await createApplicationFromLead({ tenantId: sess.tenantId, leadId });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  const appId = result.applicationId;

  // 2. Build the application patch: guarantee the lead link, FORCE status="declined",
  //    and gap-fill the merchant-application identity from the lead (same canonical
  //    extractor promote uses; never clobbers a value already set).
  const patch: Record<string, unknown> = { lead_id: leadId, status: "declined" };
  try {
    const app = await getRecord({ tenant_id: sess.tenantId, entity: "application", id: appId });
    const appData = (app?.data || {}) as Record<string, unknown>;
    const leadFields = extractAppFields(lead.data as Record<string, unknown>);
    for (const [k, leadVal] of Object.entries(leadFields)) {
      const cur = appData[k];
      if (
        (cur === undefined || cur === null || cur === "") &&
        leadVal !== undefined && leadVal !== null && leadVal !== ""
      ) {
        patch[k] = leadVal;
      }
    }
  } catch {
    /* best-effort backfill — the link + status below are still guaranteed */
  }

  // 3. Land the application in Applications › Declined, then move the lead off the
  //    Leads board. Stamp the app FIRST (status=declined + promoted_at) so a failure
  //    on the lead update leaves the deal on Applications rather than nowhere.
  //    Setting `status` via updateRecord fires BRAVO_RECORD_STATUS_CHANGED.
  try {
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "application",
      id: appId,
      patch: { ...patch, promoted_at: new Date().toISOString() },
    });
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "lead",
      id: leadId,
      patch: { transferred_at: new Date().toISOString(), application_id: appId },
    });
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    return NextResponse.json(
      {
        ok: false,
        error: "decline_incomplete",
        code,
        application_id: appId,
        message: "Application set to declined but the lead could not be moved. Retry.",
      },
      { status: 500 },
    );
  }

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
