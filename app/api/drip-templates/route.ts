import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const result = await getServiceSupabase()
    .from("cc_email_templates")
    .select("id,name,category,subject,preheader,html,updated_at")
    .eq("tenant_id", session.tenantId)
    .like("category", "drip:%")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (result.error) return NextResponse.json({ ok: false, error: result.error.message }, { status: 500 });
  return NextResponse.json({
    ok: true,
    templates: (result.data || []).map((row) => ({ ...row, label: row.name })),
  });
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body: { name?: string; category?: string; subject?: string; preheader?: string; html?: string } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const name = String(body.name || "").trim();
  const subject = String(body.subject || "").trim();
  const plain = String(body.preheader || "").trim();
  if (!name || !subject || !plain) {
    return NextResponse.json({ ok: false, error: "name_subject_and_plain_body_required" }, { status: 400 });
  }
  const requestedCategory = String(body.category || "drip:custom:jordan_direct");
  const category = requestedCategory.startsWith("drip:") ? requestedCategory : "drip:custom:jordan_direct";
  const result = await getServiceSupabase()
    .from("cc_email_templates")
    .insert({
      tenant_id: session.tenantId,
      name,
      category,
      subject,
      preheader: plain,
      html: String(body.html || ""),
      created_by: session.userId,
    })
    .select("id")
    .single();
  if (result.error) return NextResponse.json({ ok: false, error: result.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: result.data.id });
}
