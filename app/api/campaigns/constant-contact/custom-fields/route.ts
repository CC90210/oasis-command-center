/**
 * /api/campaigns/constant-contact/custom-fields
 *   GET  → all contact custom fields.
 *   POST → create a custom field (needs label + type).
 * Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  try {
    const result = await gate.ctx.client.getCustomFields();
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  if (!body.label || typeof body.label !== "string") {
    return NextResponse.json({ ok: false, error: "label_required" }, { status: 400 });
  }

  try {
    const result = await gate.ctx.client.createCustomField(body);
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}
