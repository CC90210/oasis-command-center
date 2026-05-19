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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;

type NoteRow = {
  id: string;
  content_preview: string | null;
  agent_source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export async function GET(
  _req: NextRequest,
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
  const db = getServiceSupabase();
  const r = await db
    .from("lead_interactions")
    .select("id, content_preview, agent_source, created_at, metadata")
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", id)
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

  const db = getServiceSupabase();
  const ins = await db
    .from("lead_interactions")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: id,
      channel: "note",
      direction: "internal",
      agent_source: "operator_note",
      content_preview: note,
      metadata: {
        author_email: sess.email,
        author_profile_id: sess.profileId,
      },
    })
    .select("id, content_preview, agent_source, created_at, metadata")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, note: ins.data });
}
