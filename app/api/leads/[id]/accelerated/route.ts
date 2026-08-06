/**
 * POST /api/leads/[id]/accelerated — toggle a lead's accelerated-chase flag
 * (2026-07-21). Body: { on: boolean }.
 *
 * Sets/clears `data.accelerated_followup`. When ON, the enroll-accelerated cron
 * enrolls the lead into the SMS-only "Accelerated statement chase". When OFF,
 * the executor's flag-cancel stops any remaining chase within one dispatch tick
 * and the lead de-lists from the accelerated view. Rep-accessible (canWriteCrm /
 * getWritableLead), fail-closed, audited — same gate as set-stage.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { updateRecord, RecordsError } from "@/lib/manifest/data";
import { isAcceleratedEligible } from "@/lib/drips/accelerated-eligibility";

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

  let body: { on?: unknown };
  try {
    body = (await req.json()) as { on?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const on = body.on === true || body.on === "true";

  const acc = await getWritableLead({ teamRole: sess.teamRole }, { tenantId: sess.tenantId, entity: "lead", id });
  if (!acc.ok) {
    return acc.reason === "role_denied"
      ? NextResponse.json({ ok: false, error: "forbidden_role", message: "Read-only members can't do this." }, { status: 403 })
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const lead = acc.record;
  if (on && !isAcceleratedEligible(lead.data)) {
    return NextResponse.json(
      { ok: false, error: "accelerated_live_subs_only", message: "Accelerated chase is only available for Live Subs." },
      { status: 409 },
    );
  }
  const was =
    lead.data.accelerated_followup === true || lead.data.accelerated_followup === "true";
  if (was === on) {
    return NextResponse.json({ ok: true, accelerated: on, noop: true });
  }

  try {
    await updateRecord({ tenant_id: sess.tenantId, entity: "lead", id, patch: { accelerated_followup: on } });
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    return NextResponse.json({ ok: false, error: "update_failed", code }, { status: 500 });
  }

  // Audit. Best-effort.
  try {
    const db = getServiceSupabase();
    const note = on ? "Accelerated chase turned ON" : "Accelerated chase turned OFF";
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: id,
      type: "note",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_accelerated_toggle",
      subject: "Accelerated chase",
      content: note,
      content_preview: note,
      metadata: { accelerated_followup: on, changed_by: sess.userId },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({ ok: true, accelerated: on });
}
