/**
 * POST /api/conversations/schedule-call — book an in-house call ("Request a call"
 * from the Conversations context panel). Inserts a 'pending' row into
 * scheduled_calls (database/115_scheduled_calls.sql); it never places a call. The
 * dispatch cron (GET+POST /api/cron/dispatch-scheduled-calls) reminds the rep when
 * the booking is due. The UI additionally offers the Google Calendar deep-link so
 * the booking drops into the rep's calendar (2-way sync is a later phase).
 *
 * Body: { lead_id?: string|null, thread_key?: string, to_phone?: string,
 *         contact_label?: string, scheduled_for: string (ISO), notes?: string }
 * DELETE ?id=<uuid> — cancel a still-pending booking (tenant-scoped).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getSessionContext } from "@/lib/team";
import { isReadOnlyRole } from "@/lib/role-gates";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_LEAD_MS = 15_000; // same buffer as scheduled-send
const MAX_NOTES = 2000;

type CallBody = {
  lead_id?: unknown;
  thread_key?: unknown;
  to_phone?: unknown;
  contact_label?: unknown;
  scheduled_for?: unknown;
  notes?: unknown;
};

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  }
  const { tenantId, userId } = session;

  // Member+ write gate (booking a call is a workflow action, not read-only).
  const roleCtx = await getSessionContext();
  if (!roleCtx || isReadOnlyRole(roleCtx.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't schedule calls." },
      { status: 403 },
    );
  }

  let body: CallBody;
  try {
    body = (await req.json().catch(() => ({}))) as CallBody;
  } catch {
    body = {};
  }

  const scheduledForMs = Date.parse(typeof body.scheduled_for === "string" ? body.scheduled_for : "");
  if (Number.isNaN(scheduledForMs)) {
    return NextResponse.json({ ok: false, error: "invalid_scheduled_for" }, { status: 400 });
  }
  if (scheduledForMs < Date.now() + MIN_LEAD_MS) {
    return NextResponse.json(
      { ok: false, error: "scheduled_for_too_soon", message: "Scheduled time must be in the future." },
      { status: 400 },
    );
  }

  const leadId = typeof body.lead_id === "string" && UUID_RE.test(body.lead_id) ? body.lead_id : null;
  const threadKey = typeof body.thread_key === "string" && body.thread_key.trim() ? body.thread_key.trim() : null;
  const toPhone = typeof body.to_phone === "string" ? normalizePhoneE164(body.to_phone) || null : null;
  const contactLabel = typeof body.contact_label === "string" ? body.contact_label.trim().slice(0, 120) || null : null;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, MAX_NOTES) || null : null;

  const db = getServiceSupabase();
  const ins = await db
    .from("scheduled_calls")
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      thread_key: threadKey,
      to_phone: toPhone,
      contact_label: contactLabel,
      actor_user_id: userId,
      scheduled_for: new Date(scheduledForMs).toISOString(),
      notes,
      status: "pending",
    })
    .select("id, scheduled_for")
    .single();

  if (ins.error) {
    console.error("[schedule-call] insert failed", ins.error.message);
    return NextResponse.json({ ok: false, error: "schedule_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: ins.data.id, scheduled_for: ins.data.scheduled_for });
}

export async function DELETE(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  }
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getServiceSupabase();
  const upd = await db
    .from("scheduled_calls")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .eq("status", "pending")
    .select("id");
  if (upd.error) {
    return NextResponse.json({ ok: false, error: "cancel_failed" }, { status: 500 });
  }
  if (!upd.data || upd.data.length === 0) {
    return NextResponse.json({ ok: false, error: "not_found_or_not_pending" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
