/**
 * /api/campaigns/constant-contact/segments/[id]
 *   GET    → segment detail.
 *   PUT    → update a segment (name + segment_criteria, a JSON string per CC).
 *   DELETE → delete a segment.
 * [id] is the CC segment_id. Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  try {
    const result = await gate.ctx.client.getSegment(id);
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  let body: { name?: string; segment_criteria?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  if (!body.name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  if (!body.segment_criteria) return NextResponse.json({ ok: false, error: "segment_criteria_required" }, { status: 400 });

  try {
    const result = await gate.ctx.client.updateSegment(id, String(body.name).trim(), String(body.segment_criteria));
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  try {
    await gate.ctx.client.deleteSegment(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return ccError(e);
  }
}
