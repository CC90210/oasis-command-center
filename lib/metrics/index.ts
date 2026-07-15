/**
 * lib/metrics/index.ts — the Metrics tab's aggregation. One tenant-scoped read
 * pass produces, PER SOURCE (drips, cold, submissions@, Constant Contact) + a
 * combined "All": a CC-parity EmailMetrics block for the CURRENT window, the
 * SAME block for the PREVIOUS equal window (for period-over-period deltas), a
 * daily TREND series (for sparklines + the area chart), and a 0-100 health
 * score. Plus the drip-only extras (funnel, per-sequence A/B, failures).
 *
 * Time-series with no new storage: every send/open/click already carries a
 * timestamp, so we fetch 2× the window and bucket events into current vs
 * previous (for deltas) and into daily buckets (for trends). Constant Contact is
 * snapshot-based (latest snapshot only), so it has current metrics but no daily
 * trend / previous delta.
 *
 * Attribution: opens/clicks are keyed by outbound_message_id = the lead_
 * interactions row id the sender pinned (send_id). We map id→source from
 * agent_source and bucket each event's period/day by the event's OWN timestamp.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  EmailCounts, EmailMetrics, MetricSource, TrendPoint,
  computeRates, emptyCounts, sumMetrics, healthScore,
} from "./types";

type Db = ReturnType<typeof getServiceSupabase>;
type ISource = "drips" | "cold" | "submissions"; // interaction-based sources (CC is snapshot-based)

// ---- Drip funnel + per-sequence extras ----
const FUNNEL_ORDER = [
  "intent_inquiry_submitted", "hot_lead", "follow_up", "missing_info",
  "sent_application", "viewed_application", "signed_application",
  "submitted_application", "shopping", "docs_out", "approved", "funded",
];
const STAGE_RANK = new Map(FUNNEL_ORDER.map((s, i) => [s, i]));
const APPLIED_RANK = STAGE_RANK.get("viewed_application")!;
const SIGNED_RANK = STAGE_RANK.get("signed_application")!;
const FUNDED_RANK = STAGE_RANK.get("funded")!;

export type MetricsHealth = "healthy" | "watch" | "spammy";

export type SequenceMetric = {
  sequenceName: string;
  channelMix: string;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  openRate: number;
  clickRate: number;
  emailSent: number;
  variants: Array<{ index: number; sent: number; opened: number; clicked: number }>;
};

export type DripExtras = {
  funnel: {
    total: number;
    stages: Array<{ stage: string; count: number }>;
    appliedPct: number; signedPct: number; fundedPct: number;
    appliedCount: number; signedCount: number; fundedCount: number;
  };
  smsSent: number;
  formViews: number;
  clickAdvances: number;
  sequences: SequenceMetric[];
  failureReasons: Array<{ reason: string; count: number }>;
  health: MetricsHealth;
};

/** Everything the tab renders for one source (or the combined view). */
export type SourceBlock = {
  metrics: EmailMetrics;
  previous: EmailMetrics;
  trend: TrendPoint[];
  healthScore: number;
};

/** Text Torrent (SMS) metrics — per-number health + campaign delivery from the
 *  outreach-intel collector's tables (real TT API data), plus our drip/1:1 SMS
 *  volume. Delivery/failure/reply are for TT bulk campaigns (the only SMS with a
 *  delivery status); drip SMS is send-attempt volume (no per-message DLR). */
export type SmsNumberHealth = {
  number: string; sent: number; delivered: number; failed: number; replies: number;
  failureRate: number; health: "healthy" | "watch" | "spammy";
};
export type SmsMetrics = {
  campaignSent: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
  replies: number;
  replyRate: number;
  repliesReceived: number; // inbound SMS in the window (from the inbox sync — any number)
  dripSent: number;
  totalSent: number;
  perRep: Array<{ rep: string; sent: number }>;
  numbers: SmsNumberHealth[];
};

export type MetricsPayload = {
  windowDays: number;
  bySource: Record<MetricSource, SourceBlock>;
  combined: SourceBlock;
  drip: DripExtras;
  sms: SmsMetrics;
  generatedAt: string;
};

function healthLabelFrom(bounceRate: number, complaintRate: number, failRate: number): MetricsHealth {
  if (complaintRate >= 0.003 || bounceRate >= 0.05 || failRate >= 0.15) return "spammy";
  if (complaintRate >= 0.001 || bounceRate >= 0.02 || failRate >= 0.08) return "watch";
  return "healthy";
}

function failureBucket(err: string | null): string {
  const e = (err || "").toLowerCase();
  if (!e) return "unknown";
  if (e.startsWith("skipped:")) return "skipped (channel n/a)";
  if (e.includes("opted_out") || e.includes("replied stop")) return "opted out";
  if (e.includes("suppressed")) return "suppressed";
  if (e.includes("blast_safety") || e.includes("positioning") || e.includes("lender")) return "blocked copy";
  if (e.includes("sms_identity")) return "sms identity";
  if (e.includes("quiet_hours") || e.includes("tcpa")) return "quiet hours";
  if (e.includes("rate_limit")) return "rate limited";
  if (e.includes("suppression_check_failed")) return "suppression check failed";
  if (e.includes("lead_not_found") || e.includes("sequence_")) return "definition/lead issue";
  return "send error";
}

function sourceFromAgent(agent: string): ISource | null {
  if (agent.startsWith("sequence:")) return "drips";
  if (agent.startsWith("cold:")) return "cold";
  if (agent.startsWith("submissions:")) return "submissions";
  return null;
}

function sourceFromSuppression(sourceField: string): ISource | null {
  const s = (sourceField || "").toLowerCase();
  if (s.includes("constant_contact")) return null;
  if (s.includes("smartlead") || s.startsWith("web_form:cold")) return "cold";
  if (s.includes("submissions_dsn") || s.startsWith("web_form:submissions")) return "submissions";
  if (s.startsWith("web_form")) return "drips";
  return "submissions";
}

const ISOURCES: ISource[] = ["drips", "cold", "submissions"];
const dayOf = (iso: string | null): string => (iso || "").slice(0, 10);
const ms = (iso: string | null): number => (iso ? new Date(iso).getTime() : 0);

function emptyBlock(): SourceBlock {
  const m = computeRates(emptyCounts());
  return { metrics: m, previous: m, trend: [], healthScore: 0 };
}

export async function getEmailMetrics(tenantId: string, days = 30): Promise<MetricsPayload> {
  const db: Db = getServiceSupabase();
  const win = Math.min(90, Math.max(1, days));
  const nowMs = Date.now();
  const curStartMs = nowMs - win * 86_400_000;
  const prevStartMs = nowMs - 2 * win * 86_400_000;
  const curStartIso = new Date(curStartMs).toISOString();
  const prevStartIso = new Date(prevStartMs).toISOString();

  const empty: MetricsPayload = {
    windowDays: win,
    bySource: { drips: emptyBlock(), cold: emptyBlock(), submissions: emptyBlock(), constant_contact: emptyBlock() },
    combined: emptyBlock(),
    drip: {
      funnel: { total: 0, stages: [], appliedPct: 0, signedPct: 0, fundedPct: 0, appliedCount: 0, signedCount: 0, fundedCount: 0 },
      smsSent: 0, formViews: 0, clickAdvances: 0, sequences: [], failureReasons: [], health: "healthy",
    },
    sms: { campaignSent: 0, delivered: 0, failed: 0, deliveryRate: 0, replies: 0, replyRate: 0, repliesReceived: 0, dripSent: 0, totalSent: 0, perRep: [], numbers: [] },
    generatedAt: new Date().toISOString(),
  };
  if (!tenantId) return empty;

  try {
    const [leadsRes, runsRes, intxRes, opensRes, clicksRes, viewsRes, suppRes, ccRunsRes, numHealthRes, inboundSmsRes] = await Promise.all([
      db.from("tenant_records").select("data").eq("tenant_id", tenantId).eq("entity_type", "lead"),
      db.from("drip_runs").select("sequence_name, status, last_error").eq("tenant_id", tenantId).gte("created_at", curStartIso),
      // 2× window for period-over-period. Inside .or(), like-wildcards are '*'.
      db.from("lead_interactions").select("id, lead_id, channel, agent_source, metadata, created_at")
        .eq("tenant_id", tenantId).or("agent_source.like.sequence:*,agent_source.like.cold:*,agent_source.like.submissions:*")
        .gte("created_at", prevStartIso).limit(50000),
      db.from("email_open_events").select("lead_id, outbound_message_id, suspicious_prefetch, created_at").eq("tenant_id", tenantId).gte("created_at", prevStartIso).limit(50000),
      db.from("email_click_events").select("lead_id, outbound_message_id, clicked_at").eq("tenant_id", tenantId).gte("clicked_at", prevStartIso).limit(50000),
      db.from("form_views").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).gte("created_at", curStartIso),
      db.from("email_suppressions").select("reason, source, added_at").eq("tenant_id", tenantId).gte("added_at", prevStartIso),
      db.from("campaign_runs").select("tt_campaign_id").eq("tenant_id", tenantId).eq("channel", "constant_contact").gte("launched_at", curStartIso).limit(500),
      // Text Torrent (SMS) per-number health — the collector's real TT-API rollup.
      db.from("campaign_number_health").select("send_from, sent, delivered, failed, replies, failure_rate, health").eq("tenant_id", tenantId).limit(200),
      // Inbound SMS replies in the window (from the inbox sync cron).
      db.from("lead_interactions").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("channel", "sms").eq("direction", "inbound").gte("created_at", curStartIso),
    ]);

    // ---- Drip funnel (current-stage distribution, all-time snapshot) ----
    const stageCounts: Record<string, number> = {};
    let total = 0, appliedCount = 0, signedCount = 0, fundedCount = 0;
    for (const r of (leadsRes.data || []) as Array<{ data: Record<string, unknown> | null }>) {
      const d = r.data || {};
      const stage = (typeof d.stage === "string" ? d.stage : typeof d.status === "string" ? d.status : "unset") as string;
      if (stage === "archived") continue;
      stageCounts[stage] = (stageCounts[stage] || 0) + 1;
      total += 1;
      const rank = STAGE_RANK.get(stage);
      if (rank !== undefined) {
        if (rank >= APPLIED_RANK) appliedCount += 1;
        if (rank >= SIGNED_RANK) signedCount += 1;
        if (rank >= FUNDED_RANK) fundedCount += 1;
      }
    }
    const funnelStages = FUNNEL_ORDER.filter((s) => stageCounts[s]).map((s) => ({ stage: s, count: stageCounts[s] }));

    // ---- Windowed counts (cur/prev) + per-source send map + daily trend ----
    const cur: Record<ISource, EmailCounts> = { drips: emptyCounts(), cold: emptyCounts(), submissions: emptyCounts() };
    const prev: Record<ISource, EmailCounts> = { drips: emptyCounts(), cold: emptyCounts(), submissions: emptyCounts() };
    const curOpen: Record<ISource, Set<string>> = { drips: new Set(), cold: new Set(), submissions: new Set() };
    const prevOpen: Record<ISource, Set<string>> = { drips: new Set(), cold: new Set(), submissions: new Set() };
    const curClick: Record<ISource, Set<string>> = { drips: new Set(), cold: new Set(), submissions: new Set() };
    const prevClick: Record<ISource, Set<string>> = { drips: new Set(), cold: new Set(), submissions: new Set() };
    const trendMap: Record<ISource, Map<string, { sent: number; opens: number; clicks: number }>> = {
      drips: new Map(), cold: new Map(), submissions: new Map(),
    };
    const bump = (src: ISource, day: string, k: "sent" | "opens" | "clicks") => {
      let d = trendMap[src].get(day);
      if (!d) { d = { sent: 0, opens: 0, clicks: 0 }; trendMap[src].set(day, d); }
      d[k] += 1;
    };

    const sendSource = new Map<string, ISource>();
    const perSeq = new Map<string, SequenceMetric>();
    const seqChannels = new Map<string, Set<string>>();
    const dripMsg = new Map<string, { seq: string; variant: number }>(); // current-window drip email sends, for A/B
    let smsSent = 0;
    const smsPerRep = new Map<string, number>();
    const seqGet = (name: string): SequenceMetric => {
      let m = perSeq.get(name);
      if (!m) { m = { sequenceName: name, channelMix: "", sent: 0, opened: 0, clicked: 0, failed: 0, openRate: 0, clickRate: 0, emailSent: 0, variants: [] }; perSeq.set(name, m); }
      return m;
    };

    for (const r of (intxRes.data || []) as Array<{ id: string; lead_id: string | null; channel: string; agent_source: string; metadata: Record<string, unknown> | null; created_at: string | null }>) {
      const md = r.metadata || {};
      if (md.dry_run !== false) continue; // real sends only
      const src = sourceFromAgent(r.agent_source || "");
      if (!src) continue;
      const t = ms(r.created_at);
      const period = t >= curStartMs ? "cur" : t >= prevStartMs ? "prev" : null;
      if (r.channel === "email") {
        sendSource.set(r.id, src);
        if (period === "cur") { cur[src].sent += 1; bump(src, dayOf(r.created_at), "sent"); }
        else if (period === "prev") prev[src].sent += 1;
      } else if (r.channel === "sms" && src === "drips" && period === "cur") {
        smsSent += 1;
        const rep = typeof md.rep === "string" && md.rep ? md.rep : "other";
        smsPerRep.set(rep, (smsPerRep.get(rep) || 0) + 1);
      }
      // drip per-sequence extras — CURRENT window only
      if (src === "drips" && period === "cur") {
        const seq = (r.agent_source || "sequence:").replace(/^sequence:/, "") || "(unnamed)";
        const variant = typeof md.variant_index === "number" ? md.variant_index : 0;
        const m = seqGet(seq);
        m.sent += 1;
        if (r.channel === "email") { m.emailSent += 1; dripMsg.set(r.id, { seq, variant }); }
        if (!seqChannels.has(seq)) seqChannels.set(seq, new Set());
        seqChannels.get(seq)!.add(r.channel);
        let v = m.variants.find((x) => x.index === variant);
        if (!v) { v = { index: variant, sent: 0, opened: 0, clicked: 0 }; m.variants.push(v); }
        v.sent += 1;
      }
    }

    // ---- Opens (genuine) → period + day by the OPEN's own timestamp ----
    for (const o of (opensRes.data || []) as Array<{ lead_id: string | null; outbound_message_id: string; suspicious_prefetch: boolean | null; created_at: string | null }>) {
      if (o.suspicious_prefetch) continue;
      const src = sendSource.get(o.outbound_message_id);
      if (!src) continue;
      const t = ms(o.created_at);
      if (t >= curStartMs) {
        cur[src].opens += 1;
        if (o.lead_id) curOpen[src].add(o.lead_id);
        bump(src, dayOf(o.created_at), "opens");
        const info = dripMsg.get(o.outbound_message_id);
        if (info) { const m = seqGet(info.seq); m.opened += 1; const v = m.variants.find((x) => x.index === info.variant); if (v) v.opened += 1; }
      } else if (t >= prevStartMs) {
        prev[src].opens += 1;
        if (o.lead_id) prevOpen[src].add(o.lead_id);
      }
    }

    // ---- Clicks → period + day by the CLICK's own timestamp ----
    for (const c of (clicksRes.data || []) as Array<{ lead_id: string | null; outbound_message_id: string; clicked_at: string | null }>) {
      const src = sendSource.get(c.outbound_message_id);
      if (!src) continue;
      const t = ms(c.clicked_at);
      if (t >= curStartMs) {
        cur[src].clicks += 1;
        if (c.lead_id) curClick[src].add(c.lead_id);
        bump(src, dayOf(c.clicked_at), "clicks");
        const info = dripMsg.get(c.outbound_message_id);
        if (info) { const m = seqGet(info.seq); m.clicked += 1; const v = m.variants.find((x) => x.index === info.variant); if (v) v.clicked += 1; }
      } else if (t >= prevStartMs) {
        prev[src].clicks += 1;
        if (c.lead_id) prevClick[src].add(c.lead_id);
      }
    }

    for (const src of ISOURCES) {
      cur[src].uniqueOpens = curOpen[src].size;
      cur[src].uniqueClicks = curClick[src].size;
      prev[src].uniqueOpens = prevOpen[src].size;
      prev[src].uniqueClicks = prevClick[src].size;
    }

    // ---- Drip run statuses → failures (current window) ----
    const failReasonCounts = new Map<string, number>();
    let failedTotal = 0;
    for (const r of (runsRes.data || []) as Array<{ sequence_name: string; status: string; last_error: string | null }>) {
      if (r.status === "failed") {
        failedTotal += 1;
        seqGet(r.sequence_name || "(unnamed)").failed += 1;
        const bucket = failureBucket(r.last_error);
        failReasonCounts.set(bucket, (failReasonCounts.get(bucket) || 0) + 1);
      }
    }
    for (const m of perSeq.values()) {
      m.openRate = m.emailSent ? m.opened / m.emailSent : 0;
      m.clickRate = m.emailSent ? m.clicked / m.emailSent : 0;
      m.variants.sort((a, b) => a.index - b.index);
      const chans = seqChannels.get(m.sequenceName);
      m.channelMix = chans ? Array.from(chans).sort().join("+") : "";
    }
    const sequences = Array.from(perSeq.values()).sort((a, b) => b.sent - a.sent);

    // ---- Suppressions → bounce/unsub/complaint per source + period ----
    for (const s of (suppRes.data || []) as Array<{ reason: string | null; source: string | null; added_at: string | null }>) {
      const src = sourceFromSuppression(s.source || "");
      if (!src) continue; // CC handled by snapshot
      const t = ms(s.added_at);
      const bucket = t >= curStartMs ? cur[src] : t >= prevStartMs ? prev[src] : null;
      if (!bucket) continue;
      bucket.isProxy = true;
      const reason = (s.reason || "").toLowerCase();
      if (reason.includes("bounce")) bucket.bounces += 1;
      else if (reason.includes("abuse") || reason.includes("complaint") || reason.includes("spam")) bucket.complaints += 1;
      else bucket.unsubscribes += 1;
    }

    // ---- Constant Contact source: latest snapshot per CC campaign (current only) ----
    const ccCounts = emptyCounts();
    const ccIds = ((ccRunsRes.data || []) as Array<{ tt_campaign_id: string }>).map((r) => r.tt_campaign_id).filter(Boolean);
    if (ccIds.length) {
      const snapRes = await db
        .from("campaign_metric_snapshots")
        .select("tt_campaign_id, snapshot_at, delivered, opens, unique_opens, clicks, unique_clicks, bounces, optouts, complaints")
        .eq("tenant_id", tenantId).in("tt_campaign_id", ccIds)
        .order("snapshot_at", { ascending: false }).limit(5000);
      const seen = new Set<string>();
      for (const s of (snapRes.data || []) as Array<Record<string, number | string>>) {
        const id = String(s.tt_campaign_id);
        if (seen.has(id)) continue;
        seen.add(id);
        ccCounts.sent += Number(s.delivered || 0);
        ccCounts.bounces += Number(s.bounces || 0);
        ccCounts.opens += Number(s.opens || 0);
        ccCounts.uniqueOpens += Number(s.unique_opens || 0);
        ccCounts.clicks += Number(s.clicks || 0);
        ccCounts.uniqueClicks += Number(s.unique_clicks || 0);
        ccCounts.unsubscribes += Number(s.optouts || 0);
        ccCounts.complaints += Number(s.complaints || 0);
      }
    }

    // ---- Fill daily trend (continuous days, ascending) ----
    const trendFor = (src: ISource): TrendPoint[] => {
      const out: TrendPoint[] = [];
      for (let i = win - 1; i >= 0; i--) {
        const day = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10);
        const d = trendMap[src].get(day);
        out.push({ date: day, sent: d?.sent || 0, opens: d?.opens || 0, clicks: d?.clicks || 0 });
      }
      return out;
    };
    const combinedTrend = (): TrendPoint[] => {
      const out: TrendPoint[] = [];
      const dr = trendFor("drips"), co = trendFor("cold"), su = trendFor("submissions");
      for (let i = 0; i < dr.length; i++) {
        out.push({ date: dr[i].date, sent: dr[i].sent + co[i].sent + su[i].sent, opens: dr[i].opens + co[i].opens + su[i].opens, clicks: dr[i].clicks + co[i].clicks + su[i].clicks });
      }
      return out;
    };

    const blockFor = (m: EmailMetrics, p: EmailMetrics, trend: TrendPoint[]): SourceBlock => ({
      metrics: m, previous: p, trend, healthScore: healthScore(m),
    });

    const mDrips = computeRates(cur.drips), mCold = computeRates(cur.cold), mSub = computeRates(cur.submissions), mCC = computeRates(ccCounts);
    const bySource: Record<MetricSource, SourceBlock> = {
      drips: blockFor(mDrips, computeRates(prev.drips), trendFor("drips")),
      cold: blockFor(mCold, computeRates(prev.cold), trendFor("cold")),
      submissions: blockFor(mSub, computeRates(prev.submissions), trendFor("submissions")),
      constant_contact: blockFor(mCC, computeRates(emptyCounts()), []), // snapshot: no daily trend / prev
    };
    const combinedMetrics = sumMetrics([cur.drips, cur.cold, cur.submissions, ccCounts]);
    const combinedPrev = sumMetrics([prev.drips, prev.cold, prev.submissions]);
    const combined = blockFor(combinedMetrics, combinedPrev, combinedTrend());

    const failRate = combinedMetrics.sent + smsSent + failedTotal ? failedTotal / (combinedMetrics.sent + smsSent + failedTotal) : 0;
    const health = healthLabelFrom(mDrips.bounceRate, mDrips.complaintRate, failRate);

    // ---- Text Torrent (SMS) block ----
    const numbers: SmsNumberHealth[] = ((numHealthRes.data || []) as Array<{ send_from: string; sent: number; delivered: number; failed: number; replies: number; failure_rate: number | string; health: string }>)
      .map((n) => ({
        number: n.send_from || "—",
        sent: Number(n.sent) || 0,
        delivered: Number(n.delivered) || 0,
        failed: Number(n.failed) || 0,
        replies: Number(n.replies) || 0,
        failureRate: Number(n.failure_rate) || 0,
        health: (n.health === "spammy" || n.health === "watch" ? n.health : "healthy") as SmsNumberHealth["health"],
      }))
      .sort((a, b) => b.failureRate - a.failureRate);
    let smsCampaignSent = 0, smsDelivered = 0, smsFailed = 0, smsReplies = 0;
    for (const n of numbers) { smsCampaignSent += n.sent; smsDelivered += n.delivered; smsFailed += n.failed; smsReplies += n.replies; }
    const sms: SmsMetrics = {
      campaignSent: smsCampaignSent,
      delivered: smsDelivered,
      failed: smsFailed,
      deliveryRate: smsCampaignSent ? smsDelivered / smsCampaignSent : 0,
      replies: smsReplies,
      replyRate: smsCampaignSent ? smsReplies / smsCampaignSent : 0,
      repliesReceived: inboundSmsRes.count || 0,
      dripSent: smsSent,
      totalSent: smsCampaignSent + smsSent,
      perRep: Array.from(smsPerRep.entries()).map(([rep, sent]) => ({ rep, sent })).sort((a, b) => b.sent - a.sent),
      numbers,
    };

    return {
      windowDays: win,
      bySource,
      combined,
      sms,
      drip: {
        funnel: {
          total, stages: funnelStages, appliedCount, signedCount, fundedCount,
          appliedPct: total ? appliedCount / total : 0,
          signedPct: total ? signedCount / total : 0,
          fundedPct: total ? fundedCount / total : 0,
        },
        smsSent,
        formViews: viewsRes.count || 0,
        clickAdvances: curClick.drips.size,
        sequences,
        failureReasons: Array.from(failReasonCounts.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
        health,
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[metrics] getEmailMetrics failed", err);
    return empty;
  }
}
