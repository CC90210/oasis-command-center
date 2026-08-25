/**
 * /api/leads/[id]/notes — operator-written notes on a lead.
 *
 * Stored in `lead_interactions` with channel='note', direction='internal',
 * agent_source='operator_note'. That table is already the unified
 * interaction ledger (migrations 003 + 049), already tenant-scoped,
 * already surfaced by /api/leads/[id]/timeline. Reusing it instead of
 * introducing a `lead_notes` table means notes show up in the timeline
 * automatically and stay part of the lead's audit trail.
 *
 * Auth: session-cookie → tenant via resolveSessionContext.
 *
 *   GET   — list the lead's notes, newest first, 100 max.
 *   POST  — body { note: string } — insert one note.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLeadTarget } from "@/lib/lead-access";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { updateRecord, RecordsError } from "@/lib/manifest/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;

type NoteRow = {
  id: string;
  content: string | null;
  content_preview: string | null;
  agent_source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export async function GET(
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
  // Per-agent lock + entity resolve: notes disclose lead context — an agent can't
  // read another agent's notes by guessing the id; the drawer opens for both lead
  // and application records, so resolve the linked lead id (Codex 2026-06-19 MEDIUM).
  const target = await getAccessibleLeadTarget(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, id, entityParam: req.nextUrl.searchParams.get("entity") },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("lead_interactions")
    .select("id, content, content_preview, agent_source, created_at, metadata")
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", target.queryLeadId)
    .eq("channel", "note")
    .order("created_at", { ascending: false })
    .limit(100);
  if (r.error) {
    return NextResponse.json({ ok: false, error: r.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, notes: (r.data || []) as NoteRow[] });
}

export async function POST(
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
  const target = await getAccessibleLeadTarget(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, id, entityParam: req.nextUrl.searchParams.get("entity") },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId: target.queryLeadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: "owned_oasis_sales",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }
  let body: { note?: unknown };
  try {
    body = (await req.json()) as { note?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const raw = typeof body.note === "string" ? body.note.trim() : "";
  if (!raw) {
    return NextResponse.json({ ok: false, error: "note_required" }, { status: 400 });
  }
  const note = raw.slice(0, MAX_NOTE_LENGTH);

  const occurredAt = new Date().toISOString();
  const db = getServiceSupabase();
  const ins = await db
    .from("lead_interactions")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: target.queryLeadId,
      // type is NOT NULL in the schema — set explicitly. `channel` is
      // the medium (note, email, sms, phone, etc.); `type` is the
      // higher-level category. Existing rows use {email_sent,
      // email_received, call, note} for type.
      type: "note",
      channel: "note",
      direction: "internal",
      agent_source: "operator_note",
      // actor_user_id is the canonical "who wrote this" field
      // (migration 078). metadata.author_* duplicates kept for
      // backwards-compat with pre-migration analytics; can drop
      // once every reader has been updated.
      actor_user_id: sess.userId,
      content: note,
      content_preview: note.length > 1024 ? note.slice(0, 1024) : note,
      created_at: occurredAt,
      metadata: {
        author_email: sess.email,
        author_profile_id: sess.profileId,
      },
    })
    .select("id, content, content_preview, agent_source, created_at, metadata")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  }
  try {
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "lead",
      id: target.queryLeadId,
      patch: { last_contacted_at: occurredAt },
    });
  } catch (error) {
    const code = error instanceof RecordsError ? error.code : "unknown";
    return NextResponse.json(
      { ok: false, error: "touch_update_failed", code, noteSaved: true, note: ins.data },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, note: ins.data, touchAt: occurredAt });
}
