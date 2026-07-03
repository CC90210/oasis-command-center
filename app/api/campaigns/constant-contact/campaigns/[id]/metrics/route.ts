/**
 * GET /api/campaigns/constant-contact/campaigns/[id]/metrics — deep metrics for
 * one campaign: live aggregate stats + per-link engagement + our snapshot trend
 * from campaign_metric_snapshots. [id] is the CC campaign_id. Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Activity = { role?: string; campaign_activity_id: string };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  const { client, session } = gate.ctx;

  try {
    const camp = (await client.getCampaign(id)) as { campaign_activities?: Activity[] };
    const acts = camp.campaign_activities || [];
    const primary = acts.find((a) => a.role === "primary_email") || acts[0];
    const activityId = primary?.campaign_activity_id;

    let stats = null;
    let links = null;
    if (activityId) {
      [stats, links] = await Promise.all([
        client.getCampaignStats(activityId).catch(() => null),
        client.getLinksReport(activityId).catch(() => null),
      ]);
    }

    const db = getServiceSupabase();
    const snaps = await db
      .from("campaign_metric_snapshots")
      .select("snapshot_at, delivered, opens, unique_opens, clicks, bounces, optouts, open_rate, click_rate")
      .eq("tenant_id", session.tenantId)
      .eq("tt_campaign_id", id)
      .order("snapshot_at", { ascending: true })
      .limit(300);

    return NextResponse.json({ ok: true, activity_id: activityId ?? null, stats, links, trend: snaps.data || [] });
  } catch (e) {
    return ccError(e);
  }
}
