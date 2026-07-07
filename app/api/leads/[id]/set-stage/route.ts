/**
 * POST /api/leads/[id]/set-stage — one-click stage change (Batch 6.1).
 *
 * Body: { stage: string, entity?: "lead" | "application" }
 * Sets the lead's `stage` (or the application's `status`) to a valid pipeline
 * stage. Goes through `updateRecord` so the existing BRAVO_RECORD_STATUS_CHANGED
 * publisher fires (drip engine / feed pick it up) — same path the kanban uses.
 *
 * Auth: role-based CRM-write (canWriteCrm / getWritableLead — 2026-07-07 conversion
 * from getAccessibleLead). Any non-read_only tenant member may set a stage on ANY
 * lead/application in their tenant (LEAD_SCOPING_ENABLED no longer narrows this
 * action). Fail closed. Audited to lead_interactions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { updateRecord, RecordsError } from "@/lib/manifest/data";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { stage?: unknown; entity?: unknown };
  try {
    body = (await req.json()) as { stage?: unknown; entity?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const entity = body.entity === "application" ? "application" : "lead";
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";
  const validStages = entity === "application" ? OPPORTUNITY_PIPELINE_STAGES : LEAD_PIPELINE_STAGES;
  if (!stage || !validStages.some((s) => s.key === stage)) {
    return NextResponse.json({ ok: false, error: "invalid_stage" }, { status: 400 });
  }

  // Role-based CRM-write gate — any non-read_only member may act on any tenant lead.
  // Converted from getAccessibleLead (visibility/scoping gate) to getWritableLead
  // (role gate) on 2026-07-07 so LEAD_SCOPING_ENABLED no longer narrows this action.
  const acc = await getWritableLead(
    { teamRole: sess.teamRole },
    { tenantId: sess.tenantId, entity, id },
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

  const field = entity === "application" ? "status" : "stage";
  const from = typeof lead.data[field] === "string" ? (lead.data[field] as string) : null;
  if (from === stage) {
    return NextResponse.json({ ok: true, from, to: stage, noop: true });
  }

  try {
    await updateRecord({ tenant_id: sess.tenantId, entity, id, patch: { [field]: stage } });
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    return NextResponse.json({ ok: false, error: "update_failed", code }, { status: 500 });
  }

  // Audit. Best-effort.
  try {
    const db = getServiceSupabase();
    const note = `Stage changed ${from || "—"} → ${stage}`;
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: id,
      type: "stage_changed",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_set_stage",
      subject: "Stage changed",
      content: note,
      content_preview: note,
      metadata: { from, to: stage, field, entity, changed_by: sess.userId },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({ ok: true, from, to: stage });
}
