/**
 * GET /api/cron/collect-cc-metrics — poll Constant Contact for each recent email
 * blast's aggregate stats (opens/clicks/bounces/optouts) and snapshot them into
 * campaign_metric_snapshots; also pull CC opt-outs into email_suppressions so
 * SunBiz honors CC unsubscribes everywhere. Mirrors collect-outreach-intel:
 * Bearer SCAN_TRIGGER_SECRET / CRON_SECRET auth, DRY-RUN unless ?write=1.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getConstantContactClient } from "@/lib/integrations/constant-contact/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Stats = { sends: number; opens: number; unique_opens: number; clicks: number; bounces: number; optouts: number; complaints: number };

function extractStats(resp: unknown): Stats | null {
  const r = resp as Record<string, unknown> | null;
  const stats = ((r?.results as { stats?: Record<string, unknown> }[] | undefined)?.[0]?.stats || (r?.stats as Record<string, unknown>) || r) as Record<string, unknown> | undefined;
  if (!stats) return null;
  const n = (k: string) => Number(stats[`em_${k}`] ?? stats[k] ?? 0) || 0;
  return {
    sends: n("sends"),
    opens: n("opens"),
    unique_opens: n("unique_opens") || n("opens"),
    clicks: n("clicks"),
    bounces: n("bounces") || n("hard_bounces") + n("soft_bounces"),
    optouts: n("optouts") || n("opt_outs"),
    complaints: n("abuse") || n("complaints"),
  };
}

function extractEmails(resp: unknown): string[] {
  const r = resp as Record<string, unknown> | null;
  const rows = ((r?.tracking_activities as Record<string, unknown>[]) || (Array.isArray(r) ? (r as Record<string, unknown>[]) : [])) || [];
  return rows.map((x) => String(x.email_address || "").trim().toLowerCase()).filter(Boolean);
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const write = req.nextUrl.searchParams.get("write") === "1";
  const db = getServiceSupabase();

  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const runs = await db
    .from("campaign_runs")
    .select("tenant_id, tt_campaign_id, provider_activity_id")
    .eq("channel", "constant_contact")
    .gte("launched_at", since)
    .not("provider_activity_id", "is", null)
    .limit(50);
  if (runs.error) return NextResponse.json({ ok: false, error: runs.error.message }, { status: 500 });

  const out: Record<string, unknown>[] = [];
  for (const run of (runs.data || []) as { tenant_id: string; tt_campaign_id: string; provider_activity_id: string }[]) {
    try {
      const client = await getConstantContactClient(run.tenant_id);
      if (!client) continue;
      const s = extractStats(await client.getCampaignStats(run.provider_activity_id));
      if (!s) { out.push({ id: run.tt_campaign_id, no_stats: true }); continue; }

      if (write) {
        await db.from("campaign_metric_snapshots").insert({
          tenant_id: run.tenant_id,
          tt_campaign_id: run.tt_campaign_id,
          snapshot_at: new Date().toISOString(),
          delivered: s.sends,
          opens: s.opens,
          unique_opens: s.unique_opens,
          clicks: s.clicks,
          bounces: s.bounces,
          optouts: s.optouts,
          complaints: s.complaints,
          open_rate: s.sends ? Number((s.opens / s.sends).toFixed(4)) : null,
          click_rate: s.sends ? Number((s.clicks / s.sends).toFixed(4)) : null,
          bounce_rate: s.sends ? Number((s.bounces / s.sends).toFixed(4)) : null,
          status: "collected",
        });

        // Reconcile CC opt-outs into email_suppressions (best-effort).
        if (s.optouts > 0) {
          try {
            const emails = extractEmails(await client.tracking(run.provider_activity_id, "optouts"));
            if (emails.length) {
              await db.from("email_suppressions").upsert(
                emails.map((email) => ({ tenant_id: run.tenant_id, email, brand: null as string | null, reason: "opt_out", source: "constant_contact" })),
                { onConflict: "email,tenant_id,brand" },
              );
            }
          } catch { /* best-effort opt-out sync */ }
        }
      }
      out.push({ id: run.tt_campaign_id, ...s });
    } catch (e) {
      out.push({ id: run.tt_campaign_id, error: (e as Error).message?.slice(0, 100) });
    }
  }

  return NextResponse.json({ ok: true, write, campaigns: out.length, out });
}
