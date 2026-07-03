/**
 * /api/campaigns/constant-contact/templates
 *   GET  → all templates: the code library (sunbiz + cold, rendered) + the tenant's
 *          saved custom templates.
 *   POST → save a new custom template (cc_email_templates). Admin-only.
 * These hit our Bravo table, not the CC API, so they gate on resolveSessionContext.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { listRenderedTemplates } from "@/lib/integrations/constant-contact/blast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const tpls = await listRenderedTemplates(session.tenantId);
  return NextResponse.json({ ok: true, ...tpls });
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  let body: { name?: string; category?: string; subject?: string; preheader?: string; html?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const name = String(body.name || "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });

  const db = getServiceSupabase();
  const ins = await db
    .from("cc_email_templates")
    .insert({
      tenant_id: session.tenantId,
      name,
      category: body.category || "custom",
      subject: body.subject || "",
      preheader: body.preheader || "",
      html: body.html || "",
      created_by: session.userId,
    })
    .select("id")
    .single();
  if (ins.error) return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: ins.data?.id });
}
