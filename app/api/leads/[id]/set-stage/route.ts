/**
 * POST /api/leads/[id]/set-stage — audited pipeline stage change.
 *
 * Body: { stage: string, entity?: "lead" | "application", requestId?: string, note?: string }
 * Every stage movement is a touch: the record timestamp and interaction ledger
 * are written together from one canonical occurred-at value.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { updateRecord, RecordsError } from "@/lib/manifest/data";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";
import { OASIS_LEAD_STAGES } from "@/lib/oasis-stage-meta";
import {
  OASIS_WEBSITE_SALES_PROGRAM,
  isWebsiteSalesTenantSlug,
} from "@/lib/leads/canonical-lead-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;

type StageBody = {
  stage?: unknown;
  entity?: unknown;
  requestId?: unknown;
  note?: unknown;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: StageBody;
  try {
    body = (await req.json()) as StageBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const entity = body.entity === "application" ? "application" : "lead";
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const transitionNote = typeof body.note === "string" ? body.note.trim() : "";
  if (transitionNote.length > MAX_NOTE_LENGTH) {
    return NextResponse.json({ ok: false, error: "note_too_long" }, { status: 400 });
  }

  const validStages =
    entity === "application"
      ? OPPORTUNITY_PIPELINE_STAGES
      : [...LEAD_PIPELINE_STAGES, ...OASIS_LEAD_STAGES];
  if (!stage || !validStages.some((candidate) => candidate.key === stage)) {
    return NextResponse.json({ ok: false, error: "invalid_stage" }, { status: 400 });
  }

  const access = await getWritableLead(
    { teamRole: sess.teamRole, userId: sess.userId, isOwner: sess.isTrueAdmin, adminAccess: sess.adminAccess },
    { tenantId: sess.tenantId, entity, id },
  );
  if (!access.ok) {
    return access.reason === "role_denied"
      ? NextResponse.json(
          { ok: false, error: "forbidden_role", message: "Read-only members can't do this." },
          { status: 403 },
        )
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const record = access.record;

  if (entity === "lead") {
    const db = getServiceSupabase();
    const tenant = await db
      .from("tenants")
      .select("slug")
      .eq("id", sess.tenantId)
      .maybeSingle();
    if (tenant.error) {
      return NextResponse.json(
        { ok: false, error: "tenant_lookup_failed", detail: tenant.error.message },
        { status: 500 },
      );
    }
    const tenantSlug = typeof tenant.data?.slug === "string" ? tenant.data.slug : null;
    if (
      record.data.sales_program === OASIS_WEBSITE_SALES_PROGRAM ||
      isWebsiteSalesTenantSlug(tenantSlug)
    ) {
      return NextResponse.json(
        { ok: false, error: "use_website_sales_workflow" },
        { status: 409 },
      );
    }
  }

  const field = entity === "application" ? "status" : "stage";
  const from = typeof record.data[field] === "string" ? (record.data[field] as string) : null;
  if (from === stage) {
    return NextResponse.json({ ok: true, from, to: stage, noop: true });
  }

  const occurredAt = new Date().toISOString();
  try {
    await updateRecord({
      tenant_id: sess.tenantId,
      entity,
      id,
      patch: {
        [field]: stage,
        last_contacted_at: occurredAt,
        ...(transitionNote
          ? { last_handoff_note: transitionNote, last_handoff_note_at: occurredAt }
          : {}),
      },
    });
  } catch (error) {
    const code = error instanceof RecordsError ? error.code : "unknown";
    return NextResponse.json({ ok: false, error: "update_failed", code }, { status: 500 });
  }

  const summary = `Stage changed ${from || "—"} → ${stage}`;
  const content = transitionNote ? `${summary}\n\n${transitionNote}` : summary;
  const interaction = await getServiceSupabase().from("lead_interactions").insert({
    tenant_id: sess.tenantId,
    lead_id: id,
    type: "stage_changed",
    channel: "system",
    direction: "internal",
    agent_source: "dashboard_set_stage",
    actor_user_id: sess.userId,
    subject: "Stage changed",
    content,
    content_preview: content.slice(0, 1024),
    created_at: occurredAt,
    metadata: {
      from,
      to: stage,
      field,
      entity,
      request_id: requestId || null,
    },
  });
  if (interaction.error) {
    return NextResponse.json(
      {
        ok: false,
        error: "interaction_log_failed",
        detail: interaction.error.message,
        stageUpdated: true,
        from,
        to: stage,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, from, to: stage, touchAt: occurredAt });
}
