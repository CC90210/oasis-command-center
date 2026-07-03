/**
 * /api/campaigns/constant-contact/templates/[id]
 *   PUT    → update a saved custom template.
 *   DELETE → delete a saved custom template.
 * Custom templates only (cc_email_templates), scoped to the caller's tenant. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  let body: { name?: string; category?: string; subject?: string; preheader?: string; html?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) patch.name = String(body.name).trim();
  if (body.category != null) patch.category = body.category;
  if (body.subject != null) patch.subject = body.subject;
  if (body.preheader != null) patch.preheader = body.preheader;
  if (body.html != null) patch.html = body.html;

  const db = getServiceSupabase();
  const upd = await db.from("cc_email_templates").update(patch).eq("id", id).eq("tenant_id", session.tenantId);
  if (upd.error) return NextResponse.json({ ok: false, error: upd.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  const db = getServiceSupabase();
  const del = await db.from("cc_email_templates").delete().eq("id", id).eq("tenant_id", session.tenantId);
  if (del.error) return NextResponse.json({ ok: false, error: del.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
