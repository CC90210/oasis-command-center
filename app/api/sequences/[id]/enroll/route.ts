/**
 * POST /api/sequences/[id]/enroll — manually enroll a lead in a drip
 * sequence from the dashboard. Inserts a row into `sequence_state` at
 * step_index=0 with scheduled_for=now() (or the sequence's defined
 * delay_minutes for step 0); sequence_runner.py picks it up on its
 * next tick and fires step 0 through send_gateway.
 *
 * Auth: session-cookie → tenant via resolveSessionContext.
 *
 * Honours sequence.one_per_lead: if the sequence is marked one-per-lead
 * and the lead already has a non-terminal sequence_state row for it,
 * the request returns 409 instead of creating a duplicate.
 *
 * Body: { lead_id: string (uuid) }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: sequenceId } = await ctx.params;
  if (!UUID_RE.test(sequenceId)) {
    return NextResponse.json({ ok: false, error: "invalid_sequence_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let body: { lead_id?: unknown };
  try {
    body = (await req.json()) as { lead_id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const leadId = typeof body.lead_id === "string" ? body.lead_id : "";
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }

  const db = getServiceSupabase();

  // Sequence must belong to this tenant + be enabled.
  const seq = await db
    .from("drip_sequences")
    .select("id, enabled, one_per_lead, steps")
    .eq("tenant_id", sess.tenantId)
    .eq("id", sequenceId)
    .maybeSingle();
  if (seq.error) {
    return NextResponse.json({ ok: false, error: seq.error.message }, { status: 500 });
  }
  if (!seq.data) {
    return NextResponse.json({ ok: false, error: "sequence_not_found" }, { status: 404 });
  }
  if (!(seq.data as { enabled: boolean }).enabled) {
    return NextResponse.json({ ok: false, error: "sequence_disabled" }, { status: 409 });
  }

  // one_per_lead guard — reject if the lead already has an in-flight
  // row for this sequence. Matches the daemon's enforcement so the
  // dashboard fails fast instead of letting the DB error out on the
  // partial unique index.
  if ((seq.data as { one_per_lead: boolean }).one_per_lead) {
    const existing = await db
      .from("sequence_state")
      .select("id, status")
      .eq("tenant_id", sess.tenantId)
      .eq("sequence_id", sequenceId)
      .eq("lead_id", leadId)
      .in("status", ["scheduled", "failed"])
      .limit(1);
    if (existing.data && existing.data.length > 0) {
      return NextResponse.json(
        { ok: false, error: "already_enrolled", existing_id: existing.data[0].id },
        { status: 409 },
      );
    }
  }

  // Resolve scheduled_for for step 0. If steps[0].delay_minutes is set,
  // honor it; otherwise fire now.
  const steps = (seq.data as { steps: unknown }).steps;
  const firstStep =
    Array.isArray(steps) && steps[0] && typeof steps[0] === "object"
      ? (steps[0] as Record<string, unknown>)
      : null;
  const delayMin =
    firstStep && typeof firstStep.delay_minutes === "number" ? firstStep.delay_minutes : 0;
  const scheduledFor = new Date(Date.now() + delayMin * 60_000).toISOString();

  const ins = await db
    .from("sequence_state")
    .insert({
      sequence_id: sequenceId,
      tenant_id: sess.tenantId,
      lead_id: leadId,
      step_index: 0,
      scheduled_for: scheduledFor,
      status: "scheduled",
      context_snapshot: {
        enrolled_via: "dashboard_manual",
        enrolled_by_profile_id: sess.profileId,
        enrolled_by_email: sess.email,
      },
    })
    .select("id, scheduled_for")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    enrollment_id: ins.data.id,
    scheduled_for: ins.data.scheduled_for,
  });
}
