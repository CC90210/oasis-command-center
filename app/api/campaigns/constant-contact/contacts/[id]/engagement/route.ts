/**
 * /api/campaigns/constant-contact/contacts/[id]/engagement
 *   GET → per-contact engagement rollup: activity details, open/click rates, activity summary.
 * [id] is the CC contact_id. Admin-only, fails closed. Each sub-call is best-effort
 * (null on failure) so a single missing report doesn't fail the whole drawer.
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
  const { client } = gate.ctx;

  try {
    const [activity, rates, summary] = await Promise.all([
      client.getContactActivity(id).catch(() => null),
      client.getContactOpenClickRates(id).catch(() => null),
      client.getContactActivitySummary(id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, activity, rates, summary });
  } catch (e) {
    return ccError(e);
  }
}
