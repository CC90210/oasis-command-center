/**
 * /api/campaigns/constant-contact/contacts/export
 *   POST → start an async contact export (by list_ids / segment_id / status / etc).
 *   GET  → poll an export by file_export_id (?id=).
 * Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }

  try {
    const result = await gate.ctx.client.startContactExport(body);
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}

export async function GET(req: NextRequest) {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });

  try {
    const result = await gate.ctx.client.getContactExport(id);
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}
