/**
 * GET /api/campaigns/[id]/metrics — live TextTorrent metrics for one campaign,
 * powering the campaign detail drawer.
 *
 * Pulls the verified analytics endpoints:
 *   /campaigning/analytic/details/{id}        → spend + participants + status
 *   /campaigning/analytic/details/{id}/count  → authoritative delivery counts
 *   /campaigning/analytic/details/{id}/list   → per-message roster (send_from,
 *       send_status, and the native inbound reply: received / received_message)
 *
 * Phase 1 reads TT live on open (a handful of calls under the 60/min limit); a
 * later phase snapshots into Supabase so this becomes an instant DB read.
 * Reply rate + per-number breakdown are computed from up to PAGE_CAP pages of
 * the roster; the headline totals come from /count (exact).
 */

import { NextResponse } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import {
  getTextTorrentCredentials,
  campaignDetails,
  campaignCount,
  campaignMessageList,
  TextTorrentError,
  type TtCampaignMessage,
} from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE_CAP = 6; // up to 600 messages sampled for per-number + replies
const PAGE_SIZE = 100;

function ttStatus(err: TextTorrentError): number {
  return err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
}

const isDelivered = (s?: string) => s === "delivered" || s === "sent";
const isFailed = (s?: string) => s === "failed" || s === "undelivered";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return NextResponse.json({ ok: false, error: "bad_campaign_id" }, { status: 400 });
  }

  try {
    const creds = await getTextTorrentCredentials(tenantId);
    const [details, counts] = await Promise.all([
      campaignDetails(creds, id).then((r) => r.data).catch(() => null),
      campaignCount(creds, id).then((r) => r.data).catch(() => null),
    ]);

    // Roster sample for per-number health + replies (bounded pages).
    const messages: TtCampaignMessage[] = [];
    let truncated = false;
    for (let page = 1; page <= PAGE_CAP; page++) {
      const r = await campaignMessageList(creds, id, { limit: PAGE_SIZE, page });
      messages.push(...r.data);
      if (r.data.length < PAGE_SIZE) break;
      if (page === PAGE_CAP) truncated = true;
    }

    // Per-number rollup.
    const byNumber = new Map<string, { send_from: string; sent: number; delivered: number; failed: number; replies: number }>();
    const replies: Array<{ to: string; name?: string; message: string }> = [];
    let replyCount = 0;
    for (const m of messages) {
      const key = m.send_from || "(unknown)";
      const n = byNumber.get(key) || { send_from: key, sent: 0, delivered: 0, failed: 0, replies: 0 };
      n.sent += 1;
      if (isDelivered(m.send_status)) n.delivered += 1;
      if (isFailed(m.send_status)) n.failed += 1;
      const replied = m.received === 1 || (m.received_message != null && m.received_message !== "");
      if (replied) {
        n.replies += 1;
        replyCount += 1;
        if (replies.length < 50) {
          replies.push({ to: m.send_to, message: String(m.received_message || "").slice(0, 500) });
        }
      }
      byNumber.set(key, n);
    }
    const numbers = [...byNumber.values()].map((n) => ({
      ...n,
      failure_rate: n.sent ? Math.round((n.failed / n.sent) * 1000) / 10 : 0,
    }));

    const total = counts?.total ?? messages.length;
    const delivered = counts?.completed ?? messages.filter((m) => isDelivered(m.send_status)).length;
    const failed = counts?.failed ?? messages.filter((m) => isFailed(m.send_status)).length;
    // Reply rate is over the sampled roster; flag when the sample is partial.
    const sampled = messages.length;
    const replyRate = sampled ? Math.round((replyCount / sampled) * 1000) / 10 : 0;

    return NextResponse.json({
      ok: true,
      campaign: {
        id,
        name: details?.campaign_name,
        status: details?.status,
        contact_list_id: details?.contact_list_id,
        created_at: details?.created_at,
        credits_consumed: details?.credits_consumed,
        total_participants: details?.total_participants,
      },
      counts: { total, delivered, failed, scheduled: counts?.scheduled ?? 0, processing: counts?.processing ?? 0 },
      replies: { count: replyCount, rate: replyRate, sampled, truncated, items: replies },
      numbers,
    });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: ttStatus(err) });
    }
    return NextResponse.json(
      { ok: false, error: "metrics_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}
