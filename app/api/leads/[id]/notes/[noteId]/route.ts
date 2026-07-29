import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLeadTarget } from "@/lib/lead-access";
import { canWriteCrm } from "@/lib/role-gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;

async function resolveMutation(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  const { id, noteId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(noteId)) {
    return { response: NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 }) };
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return { response: NextResponse.json({ ok: false, error: sess.reason }, { status: 401 }) };
  }
  if (!canWriteCrm(sess.teamRole)) {
    return { response: NextResponse.json({ ok: false, error: "role_denied" }, { status: 403 }) };
  }
  const target = await getAccessibleLeadTarget(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, id, entityParam: req.nextUrl.searchParams.get("entity") },
  );
  if (!target) {
    return { response: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { noteId, sess, target };
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  const resolved = await resolveMutation(req, ctx);
  if ("response" in resolved) return resolved.response;
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
  const existing = await db
    .from("lead_interactions")
    .select("metadata")
    .eq("id", resolved.noteId)
    .eq("tenant_id", resolved.sess.tenantId)
    .eq("lead_id", resolved.target.queryLeadId)
    .eq("channel", "note")
    .eq("agent_source", "operator_note")
    .maybeSingle();
  if (existing.error) {
    return NextResponse.json({ ok: false, error: existing.error.message }, { status: 500 });
  }
  if (!existing.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const oldMetadata =
    existing.data.metadata && typeof existing.data.metadata === "object"
      ? existing.data.metadata as Record<string, unknown>
      : {};
  const updated = await db
    .from("lead_interactions")
    .update({
      content: note,
      content_preview: note.length > 1024 ? note.slice(0, 1024) : note,
      metadata: {
        ...oldMetadata,
        edited_at: new Date().toISOString(),
        edited_by: resolved.sess.userId,
      },
    })
    .eq("id", resolved.noteId)
    .eq("tenant_id", resolved.sess.tenantId)
    .eq("lead_id", resolved.target.queryLeadId)
    .eq("channel", "note")
    .eq("agent_source", "operator_note")
    .select("id, content, content_preview, agent_source, created_at, metadata")
    .maybeSingle();
  if (updated.error) {
    return NextResponse.json({ ok: false, error: updated.error.message }, { status: 500 });
  }
  if (!updated.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, note: updated.data });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  const resolved = await resolveMutation(req, ctx);
  if ("response" in resolved) return resolved.response;
  const deleted = await getServiceSupabase()
    .from("lead_interactions")
    .delete()
    .eq("id", resolved.noteId)
    .eq("tenant_id", resolved.sess.tenantId)
    .eq("lead_id", resolved.target.queryLeadId)
    .eq("channel", "note")
    .eq("agent_source", "operator_note")
    .select("id")
    .maybeSingle();
  if (deleted.error) {
    return NextResponse.json({ ok: false, error: deleted.error.message }, { status: 500 });
  }
  if (!deleted.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: true });
}
