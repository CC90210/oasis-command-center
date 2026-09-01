/**
 * POST /api/leads/[id]/promote — TRANSFER a lead into the Applications pipeline.
 *
 * The Leads board and the Applications / Shop-Out boards are separate entity
 * types (lead vs application). This route is the explicit one-click bridge
 * surfaced by "Transfer to Application" in the lead drawer. It:
 *   1. creates (or reuses) the linked application at status="application_in"
 *      (createApplicationFromLead — the same helper "Run underwriting" uses,
 *      so no duplicate is ever made),
 *   2. HARDENS the link + identity on that application so the deal is never
 *      sparse and its documents always resolve (the app's data.lead_id drives
 *      lead_documents resolution in the detail + documents routes), and
 *   3. MOVES the lead off the Leads board by stamping data.transferred_at +
 *      application_id. The board filters transferred leads out, so the deal
 *      lives in exactly one place (Applications) — no duplicate cards.
 *
 * Idempotent: re-transferring reuses the same application and re-stamps.
 *
 * Auth: any non-read_only tenant member (getWritableLead / canWriteCrm, 2026-07-07);
 * read-only members denied; fail closed. Audited.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";
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
  // Role-based CRM-write gate (canWriteCrm / getWritableLead — 2026-07-07 conversion).
  // Denies read_only regardless of LEAD_SCOPING_ENABLED so any full member can promote
  // any lead in the tenant (visibility scoping must not block this CRM action).
  const acc = await getWritableLead(
    { teamRole: sess.teamRole, userId: sess.userId, isOwner: sess.isTrueAdmin, adminAccess: sess.adminAccess },
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

  // 1. Create or reuse the linked application (application_in).
  const result = await createApplicationFromLead({ tenantId: sess.tenantId, leadId });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  const appId = result.applicationId;

  // 2. Harden the application: guarantee data.lead_id (so its documents always
  //    resolve), keep it at application_in, and backfill any missing identity
  //    fields from the lead. createApplicationFromLead already sets these on a
  //    fresh create; this also covers the reuse path + repairs sparse apps.
  try {
    const app = await getRecord({ tenant_id: sess.tenantId, entity: "application", id: appId });
    const appData = (app?.data || {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (appData.lead_id !== leadId) patch.lead_id = leadId;
    if (!appData.status) patch.status = "application_in";
    // Backfill the FULL merchant-application identity from the lead (same
    // canonical extractor as createApplicationFromLead — aliases + normalization).
    // Gap-fill only: never clobber a value the form/operator already set. Repairs
    // already-created sparse applications on the reuse path.
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
    if (Object.keys(patch).length > 0) {
      await updateRecord({ tenant_id: sess.tenantId, entity: "application", id: appId, patch });
    }
  } catch {
    /* best-effort harden — the link is already guaranteed by createApplicationFromLead */
  }

  // 3. Move the lead off the board. This is the load-bearing step (the board
  //    filters on transferred_at), so surface its failure instead of swallowing
  //    it — the action is idempotent, so the UI can retry cleanly.
  try {
    // Mark the application as promoted → it now belongs on the Applications board
    // (the board filters on promoted_at, mirroring the leads board's transferred_at).
    // Stamp the app FIRST: if this fails the lead isn't transferred, so the deal
    // stays on Leads rather than vanishing from both boards.
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "application",
      id: appId,
      patch: { promoted_at: new Date().toISOString() },
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
      { ok: false, error: "transfer_incomplete", code, application_id: appId, message: "Application created but the lead could not be moved. Retry." },
      { status: 500 },
    );
  }

  // Audit. Best-effort (mirrors /set-stage).
  try {
    const db = getServiceSupabase();
    const note = result.created
      ? `Transferred to Applications — application ${appId.slice(0, 8)} created (Application In)`
      : `Transferred to Applications — linked application ${appId.slice(0, 8)}`;
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      type: "transferred_to_application",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_transfer",
      subject: "Transferred to Applications",
      content: note,
      content_preview: note,
      metadata: { application_id: appId, created: result.created, transferred_by: sess.userId },
    });
  } catch {
    /* best-effort audit */
  }

  // Generate + attach the application-form PDF from the record (best-effort,
  // non-blocking) so a transferred deal always has its app PDF on the Docs tab,
  // even when it never went through the full-application form.
  after(() => generateApplicationDocumentFromRecord({ tenantId: sess.tenantId, applicationId: appId }));

  return NextResponse.json({ ok: true, application_id: appId, created: result.created });
}
