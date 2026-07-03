/**
 * GET /api/campaigns/constant-contact/campaigns — the Campaigns manager list.
 * Merges the live CC campaign list (id, name, current_status, dates) with the
 * account summary report (last_sent_date + unique counts, keyed by campaign_id)
 * and our own campaign_runs (launched-by). Admin-only, fails closed.
 */
import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Camp = { campaign_id?: string; name?: string; current_status?: string; campaign_type?: string; created_at?: string; updated_at?: string };
type Summary = { campaign_id?: string; campaign_type?: string; last_sent_date?: string; unique_counts?: Record<string, number> };

export async function GET() {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  const { client, session } = gate.ctx;

  try {
    const [campsRaw, sumRaw] = await Promise.all([
      client.listCampaigns({ limit: 100 }).catch(() => null),
      client.getSummaryReports(100).catch(() => null),
    ]);
    const campaigns = ((campsRaw as { campaigns?: Camp[] } | null)?.campaigns || []) as Camp[];
    const summaries = ((sumRaw as { bulk_email_campaign_summaries?: Summary[] } | null)?.bulk_email_campaign_summaries || []) as Summary[];
    const sumById = new Map(summaries.map((s) => [s.campaign_id, s]));

    const db = getServiceSupabase();
    const runs = await db
      .from("campaign_runs")
      .select("tt_campaign_id, launched_by, launched_at")
      .eq("tenant_id", session.tenantId)
      .eq("channel", "constant_contact");
    const runById = new Map(((runs.data || []) as { tt_campaign_id: string; launched_by: string | null; launched_at: string | null }[]).map((r) => [String(r.tt_campaign_id), r]));

    const rows = campaigns.map((c) => {
      const s = sumById.get(c.campaign_id);
      const run = runById.get(String(c.campaign_id));
      const counts = s?.unique_counts || {};
      const sends = Number(counts.sends || 0);
      return {
        campaign_id: c.campaign_id,
        name: c.name,
        status: c.current_status || "UNKNOWN",
        type: c.campaign_type || s?.campaign_type || null,
        created_at: c.created_at || null,
        updated_at: c.updated_at || null,
        last_sent_date: s?.last_sent_date || null,
        counts,
        open_rate: sends ? Number((Number(counts.opens || 0) / sends).toFixed(4)) : null,
        click_rate: sends ? Number((Number(counts.clicks || 0) / sends).toFixed(4)) : null,
        launched_by: run?.launched_by || null,
      };
    });

    return NextResponse.json({ ok: true, campaigns: rows });
  } catch (e) {
    return ccError(e);
  }
}
