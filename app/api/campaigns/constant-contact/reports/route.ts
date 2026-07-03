/**
 * GET /api/campaigns/constant-contact/reports — account-wide email analytics.
 * Returns the CC campaign-summary rollup (aggregate open/click/bounce/unsubscribe
 * rates + per-campaign unique counts) and the contact consent counts, for the
 * Reports section. Admin-only, fails closed.
 */
import { NextResponse } from "next/server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Summary = { campaign_id?: string; campaign_type?: string; last_sent_date?: string; unique_counts?: Record<string, number> };

export async function GET() {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  const { client } = gate.ctx;

  try {
    const [sumRaw, countsRaw] = await Promise.all([
      client.getSummaryReports(100).catch(() => null),
      client.getContactCounts().catch(() => null),
    ]);

    const page = (sumRaw as { bulk_email_campaign_summaries?: Summary[]; aggregate_percents?: Record<string, number> } | null) || {};
    const summaries = (page.bulk_email_campaign_summaries || []) as Summary[];

    const campaigns = summaries.map((s) => {
      const c = s.unique_counts || {};
      const sends = Number(c.sends || 0);
      return {
        campaign_id: s.campaign_id,
        type: s.campaign_type || null,
        last_sent_date: s.last_sent_date || null,
        sends,
        opens: Number(c.opens || 0),
        clicks: Number(c.clicks || 0),
        bounces: Number(c.bounces || 0),
        optouts: Number(c.optouts || c.opt_outs || 0),
        open_rate: sends ? Number((Number(c.opens || 0) / sends).toFixed(4)) : null,
        click_rate: sends ? Number((Number(c.clicks || 0) / sends).toFixed(4)) : null,
      };
    });

    // Totals across the returned page.
    const totals = campaigns.reduce(
      (a, c) => ({ sends: a.sends + c.sends, opens: a.opens + c.opens, clicks: a.clicks + c.clicks, bounces: a.bounces + c.bounces, optouts: a.optouts + c.optouts }),
      { sends: 0, opens: 0, clicks: 0, bounces: 0, optouts: 0 },
    );

    return NextResponse.json({
      ok: true,
      aggregate_percents: page.aggregate_percents || null, // { open, click, did_not_open, bounce, unsubscribe }
      totals,
      campaigns,
      contact_counts: countsRaw || null, // { all_contacts, subscribed, unsubscribed, ... }
    });
  } catch (e) {
    return ccError(e);
  }
}
