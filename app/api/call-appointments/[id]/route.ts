/**
 * PATCH /api/call-appointments/[id] — update a call appointment's status /
 * outcome / scheduled time. Backs the call sheet's Log outcome / Reschedule /
 * Cancel actions.
 *
 * Body (all optional, at least one required):
 *   { status?: 'scheduled'|'completed'|'no_answer'|'cancelled'|'rescheduled',
 *     outcomeNote?: string, scheduledFor?: ISO string, preCallNote?: string }
 *
 * Semantics:
 *   - scheduledFor present, status absent -> "Reschedule": moves the time and
 *     marks status='rescheduled' (still visible in the default GET list,
 *     which only excludes 'cancelled'). completed_at is cleared.
 *   - status present -> applied verbatim (validated against the CHECK enum).
 *     completed_at is set to now() only when status === 'completed', and
 *     cleared otherwise, so completed_at always agrees with status.
 *   - outcomeNote / preCallNote -> updated when provided (bounded length).
 *
 * Auth: session -> tenant, then role gate (read_only denied, fail closed),
 * then row-level: only the appointment's creator or assignee may act on it
 * (tighter than the general CRM-write tier — this is the rep's own call).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isReadOnlyRole } from "@/lib/role-gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;
const PAST_GRACE_MS = 5 * 60_000;
const VALID_STATUSES = new Set(["scheduled", "completed", "no_answer", "cancelled", "rescheduled"]);

function boundedNote(v: unknown): string | null | undefined {
  if (v === undefined) return undefined; // not provided -> leave column unchanged
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, MAX_NOTE_LENGTH) : null; // explicit "" clears the note
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  // Fail-closed role gate — same standing default as every other mutation
  // in this app: read_only members act on nothing (isReadOnlyRole).
  if (isReadOnlyRole(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't update calls." },
      { status: 403 },
    );
  }

  let body: {
    status?: unknown;
    outcomeNote?: unknown;
    scheduledFor?: unknown;
    preCallNote?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  let statusProvided = false;
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !VALID_STATUSES.has(body.status)) {
      return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });
    }
    patch.status = body.status;
    patch.completed_at = body.status === "completed" ? new Date().toISOString() : null;
    statusProvided = true;
  }

  if (body.scheduledFor !== undefined) {
    if (typeof body.scheduledFor !== "string") {
      return NextResponse.json({ ok: false, error: "invalid_scheduled_for" }, { status: 400 });
    }
    const d = new Date(body.scheduledFor);
    if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - PAST_GRACE_MS) {
      return NextResponse.json(
        { ok: false, error: "invalid_scheduled_for", message: "scheduledFor must be a valid ISO time not far in the past." },
        { status: 400 },
      );
    }
    patch.scheduled_for = d.toISOString();
    // Reschedule with no explicit status -> mark as rescheduled + clear any
    // prior completion, so the row stays visible/actionable in the list.
    if (!statusProvided) {
      patch.status = "rescheduled";
      patch.completed_at = null;
    }
  }

  const outcomeNote = boundedNote(body.outcomeNote);
  if (outcomeNote !== undefined) patch.outcome_note = outcomeNote;
  const preCallNote = boundedNote(body.preCallNote);
  if (preCallNote !== undefined) patch.pre_call_note = preCallNote;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "no_fields" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const db = getServiceSupabase();
  const existing = await db
    .from("call_appointments")
    .select("id, tenant_id, created_by, assigned_to")
    .eq("id", id)
    .eq("tenant_id", sess.tenantId)
    .maybeSingle();
  if (existing.error || !existing.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const row = existing.data as { created_by: string; assigned_to: string | null };
  if (row.created_by !== sess.userId && row.assigned_to !== sess.userId) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only the appointment's creator or assignee can update it." },
      { status: 403 },
    );
  }

  const upd = await db
    .from("call_appointments")
    .update(patch)
    .eq("id", id)
    .eq("tenant_id", sess.tenantId)
    .select("*")
    .single();
  if (upd.error) {
    return NextResponse.json({ ok: false, error: "update_failed", message: upd.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, appointment: upd.data });
}
