/**
 * /api/campaigns/constant-contact/campaigns/[id]
 *   GET    → campaign detail (activity + schedule + stats + preview), for the drawer.
 *   PATCH  → rename the campaign.
 *   DELETE → delete the campaign.
 * [id] is the CC campaign_id. Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Activity = { role?: string; campaign_activity_id: string };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  const { client } = gate.ctx;

  try {
    const camp = (await client.getCampaign(id)) as { campaign_activities?: Activity[] };
    const acts = camp.campaign_activities || [];
    const primary = acts.find((a) => a.role === "primary_email") || acts[0];
    const activityId = primary?.campaign_activity_id;

    let activity = null;
    let schedule = null;
    let stats = null;
    let preview = null;
    if (activityId) {
      [activity, schedule, stats, preview] = await Promise.all([
        client.getActivity(activityId, "permalink_url,physical_address_in_footer").catch(() => null),
        client.getSchedule(activityId).catch(() => null),
        client.getCampaignStats(activityId).catch(() => null),
        client.getPreview(activityId).catch(() => null),
      ]);
    }
    return NextResponse.json({ ok: true, campaign: camp, activity_id: activityId ?? null, activity, schedule, stats, preview });
  } catch (e) {
    return ccError(e);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  let body: { name?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const name = String(body.name || "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });

  try {
    await gate.ctx.client.renameCampaign(id, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return ccError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  try {
    await gate.ctx.client.deleteCampaign(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return ccError(e);
  }
}
