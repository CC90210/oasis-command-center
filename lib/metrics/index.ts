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
import { findAgentByEmail } from "@/lib/config/agents";

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
  /** The lead stage this sequence fires on (trigger_filter.to), e.g. "viewed_application". */
  stage: string;
  /** The email step's subject line (what the merchant sees), or "" for SMS-only sequences. */
  emailSubject: string;
  channelMix: string;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  openRate: number;
  clickRate: number;
  emailSent: number;
  /** Deliverability/effectiveness signal: "low" = looks spammy/ignored (open rate far below
   *  benchmark on real volume), "watch" = soft, "ok" = healthy or not enough data. */
  health: "ok" | "watch" | "low";
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
  /** Real per-message delivery status sampled from the inbox sync's tt_send_status
   *  (drip/outbound SMS that have a status; not all sends are covered). */
  dripDeliveryChecked: number;
  dripDeliveryFailed: number;
};

/** Kixie (calls) metrics — from lead_interactions channel='phone' (the Kixie
 *  webhook receiver, deduped by kixie_call_id). */
export type CallNumberHealth = "healthy" | "warning" | "critical" | "insufficient_data";
export type CallNumberStats = {
  /** The Kixie caller ID (from_phone) the outbound dial went out on. */
  number: string;
  dials: number;
  /** Reached call_answered, or ran >= 30s (and wasn't a voicemail drop). */
  connects: number;
  /** 0-100, one decimal. */
  connectRatePct: number;
  /** Average duration of CONNECTED calls on this number. */
  avgDurationSec: number;
  /** >=15% healthy, 8-15% warning, <8% critical — only with >=20 dials in the
   *  window; fewer dials = insufficient_data (no flag on thin volume). */
  health: CallNumberHealth;
};
export type CallAgentStats = {
  /** metadata.kixie_agent_email (lowercased), or "" when the webhook carried none. */
  email: string;
  /** Roster name via agents.config.json when the email matches, else the email prefix. */
  name: string;
  dials: number;
  connects: number;
  talkTimeSec: number;
  /** ci_sentiment positive/neutral/negative → +1/0/-1, averaged over calls with a
   *  CI summary; null when this agent has none in the window. */
  avgSentiment: number | null;
};
export type CallMetrics = {
  dials: number;
  connects: number;
  connectRate: number;
  voicemails: number;
  talkTimeSec: number;
  avgTalkSec: number;
  perAgent: Array<{ agent: string; dials: number; connects: number; talkTimeSec: number }>;
  dispositions: Array<{ disposition: string; count: number }>;
  /** Per-number health for OUTBOUND dials, grouped by from_phone. */
  numbers: CallNumberStats[];
  /** Per-agent rollup keyed on metadata.kixie_agent_email, with CI sentiment. */
  agents: CallAgentStats[];
};

export type MetricsPayload = {
  windowDays: number;
  bySource: Record<MetricSource, SourceBlock>;
  combined: SourceBlock;
  drip: DripExtras;
  sms: SmsMetrics;
  calls: CallMetrics;
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
    sms: { campaignSent: 0, delivered: 0, failed: 0, deliveryRate: 0, replies: 0, replyRate: 0, repliesReceived: 0, dripSent: 0, totalSent: 0, perRep: [], numbers: [], dripDeliveryChecked: 0, dripDeliveryFailed: 0 },
    calls: { dials: 0, connects: 0, connectRate: 0, voicemails: 0, talkTimeSec: 0, avgTalkSec: 0, perAgent: [], dispositions: [], numbers: [], agents: [] },
    generatedAt: new Date().toISOString(),
  };
  if (!tenantId) return empty;

  try {
    const [leadsRes, runsRes, intxRes, opensRes, clicksRes, viewsRes, suppRes, ccRunsRes, numHealthRes, inboundSmsRes, callsRes, smsStatusRes, seqDefsRes] = await Promise.all([
      // P2 instant-load (2026-09-01): the funnel below reads ONLY stage/status,
      // but this row pulled every lead's FULL data blob — measured 44MB / 3.8-4.9s
      // on the volume tenant, on every /metrics visit, the exact bug class
      // web-leads fixed in R3. `->` (not `->>`) keeps parsed-JSON semantics
      // identical on both backends, same as web-leads' FILTER_SELECT.
      db.from("tenant_records").select("data->stage,data->status").eq("tenant_id", tenantId).eq("entity_type", "lead"),
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
      // Kixie calls in the window (channel='phone', deduped by kixie_call_id).
      db.from("lead_interactions").select("kixie_call_id, type, direction, from_phone, call_duration_sec, disposition, call_outcome, metadata").eq("tenant_id", tenantId).eq("channel", "phone").gte("created_at", curStartIso).limit(50000),
      // A2: outbound SMS carrying a real TT delivery status (from the inbox sync).
      db.from("lead_interactions").select("metadata").eq("tenant_id", tenantId).eq("channel", "sms").eq("direction", "outbound").not("metadata->>tt_send_status", "is", null).gte("created_at", curStartIso).limit(50000),
      // Sequence definitions → map each per-sequence metric to its lead STAGE + the
      // email step's SUBJECT (so the Drips tab lists every email by stage, not just name).
      db.from("drip_sequences").select("name, enabled, trigger_filter, steps").eq("tenant_id", tenantId).limit(200),
    ]);

    // ---- Drip funnel (current-stage distribution, all-time snapshot) ----
    const stageCounts: Record<string, number> = {};
    let total = 0, appliedCount = 0, signedCount = 0, fundedCount = 0;
    // Projected rows arrive as {stage, status} (one column per json path),
    // not {data: {...}} — see the projection note on the query above.
    for (const r of (leadsRes.data || []) as Array<{ stage?: unknown; status?: unknown }>) {
      const stage = (typeof r.stage === "string" ? r.stage : typeof r.status === "string" ? r.status : "unset") as string;
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
      if (!m) { m = { sequenceName: name, stage: "", emailSubject: "", channelMix: "", sent: 0, opened: 0, clicked: 0, failed: 0, openRate: 0, clickRate: 0, emailSent: 0, health: "ok", variants: [] }; perSeq.set(name, m); }
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
    // Map each sequence NAME → its lead stage (trigger_filter.to) + the email step's subject.
    const seqDef = new Map<string, { stage: string; emailSubject: string }>();
    for (const s of (seqDefsRes.data || []) as Array<{ name: string; trigger_filter: Record<string, unknown> | null; steps: unknown }>) {
      const stage = typeof s.trigger_filter?.to === "string" ? (s.trigger_filter.to as string) : "";
      const steps = Array.isArray(s.steps) ? (s.steps as Array<Record<string, unknown>>) : [];
      const emailStep = steps.find((st) => st?.channel === "email");
      const emailSubject = typeof emailStep?.subject === "string" ? (emailStep.subject as string) : "";
      if (s.name) seqDef.set(s.name, { stage, emailSubject });
    }
    for (const m of perSeq.values()) {
      m.openRate = m.emailSent ? m.opened / m.emailSent : 0;
      m.clickRate = m.emailSent ? m.clicked / m.emailSent : 0;
      m.variants.sort((a, b) => a.index - b.index);
      const chans = seqChannels.get(m.sequenceName);
      m.channelMix = chans ? Array.from(chans).sort().join("+") : "";
      const def = seqDef.get(m.sequenceName);
      m.stage = def?.stage || "";
      m.emailSubject = def?.emailSubject || "";
      // Spam/effectiveness signal — only meaningful on real email volume. MCA/B2B
      // email opens run ~20-40%; a materially lower rate reads as spam-foldered/ignored.
      m.health = m.emailSent >= 10 && m.openRate < 0.12 ? "low" : m.emailSent >= 10 && m.openRate < 0.25 ? "watch" : "ok";
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
    // A2: real per-message drip delivery status, sampled from the inbox sync's tt_send_status.
    let dripDeliveryChecked = 0, dripDeliveryFailed = 0;
    for (const r of (smsStatusRes.data || []) as Array<{ metadata: Record<string, unknown> | null }>) {
      const st = String(r.metadata?.tt_send_status || "").toLowerCase();
      if (!st) continue;
      dripDeliveryChecked += 1;
      if (st.includes("fail")) dripDeliveryFailed += 1;
    }
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
      dripDeliveryChecked,
      dripDeliveryFailed,
    };

    // ---- Kixie (calls) block — from lead_interactions channel='phone' (deduped by kixie_call_id) ----
    const callRows = (callsRes.data || []) as Array<{ kixie_call_id: string | null; type: string | null; direction: string | null; from_phone: string | null; call_duration_sec: number | null; disposition: string | null; call_outcome: string | null; metadata: Record<string, unknown> | null }>;
    const seenCall = new Set<string>();
    let dials = 0, connects = 0, voicemails = 0, talkTimeSec = 0;
    const agentMap = new Map<string, { dials: number; connects: number; talkTimeSec: number }>();
    const dispMap = new Map<string, number>();
    for (const r of callRows) {
      const cid = r.kixie_call_id || "";
      if (cid) { if (seenCall.has(cid)) continue; seenCall.add(cid); }
      dials += 1;
      const dur = Number(r.call_duration_sec) || 0;
      const isVm = r.call_outcome === "voicemail" || r.type === "call_voicemail";
      const isConnect = dur > 0 && !isVm;
      if (isVm) voicemails += 1;
      if (isConnect) { connects += 1; talkTimeSec += dur; }
      const email = typeof r.metadata?.kixie_agent_email === "string" ? (r.metadata.kixie_agent_email as string) : "";
      const rep = (email && findAgentByEmail(email)?.name) || (email ? email.split("@")[0] : "unassigned");
      let a = agentMap.get(rep);
      if (!a) { a = { dials: 0, connects: 0, talkTimeSec: 0 }; agentMap.set(rep, a); }
      a.dials += 1;
      if (isConnect) { a.connects += 1; a.talkTimeSec += dur; }
      if (r.disposition) dispMap.set(r.disposition, (dispMap.get(r.disposition) || 0) + 1);
    }

    // Per-CALL aggregation for the number-health + per-agent rollups. The Kixie
    // webhook writes one row per lifecycle event (initiated / answered / ended /
    // dispositioned / CI summary), all sharing a kixie_call_id — so these stats
    // must merge a call's rows FIRST (the first-row-wins dedupe above is fine for
    // volume counters but would drop the answered flag / duration / CI sentiment
    // when they land on a later row). Rows without a kixie_call_id (legacy) each
    // count as their own call, matching the dedupe loop's behavior.
    type CallAgg = {
      outbound: boolean; fromPhone: string; durationSec: number;
      answered: boolean; voicemail: boolean; agentEmail: string; sentiment: number | null;
    };
    const perCall = new Map<string, CallAgg>();
    let syntheticId = 0;
    for (const r of callRows) {
      const key = r.kixie_call_id || `row:${syntheticId++}`;
      let c = perCall.get(key);
      if (!c) { c = { outbound: false, fromPhone: "", durationSec: 0, answered: false, voicemail: false, agentEmail: "", sentiment: null }; perCall.set(key, c); }
      if (r.direction === "outbound" || r.type === "call_outgoing") c.outbound = true;
      if (!c.fromPhone && typeof r.from_phone === "string" && r.from_phone) c.fromPhone = r.from_phone;
      c.durationSec = Math.max(c.durationSec, Number(r.call_duration_sec) || 0);
      if (r.type === "call_answered") c.answered = true;
      if (r.call_outcome === "voicemail" || r.type === "call_voicemail") c.voicemail = true;
      const email = typeof r.metadata?.kixie_agent_email === "string" ? (r.metadata.kixie_agent_email as string).trim().toLowerCase() : "";
      if (!c.agentEmail && email) c.agentEmail = email;
      if (c.sentiment === null) {
        const s = typeof r.metadata?.ci_sentiment === "string" ? (r.metadata.ci_sentiment as string).toLowerCase() : "";
        if (s === "positive") c.sentiment = 1;
        else if (s === "neutral") c.sentiment = 0;
        else if (s === "negative") c.sentiment = -1;
      }
    }
    // A call "connects" when Kixie reported call_answered OR it ran >= 30s —
    // voicemail drops never count even when the recording pushes past 30s.
    const isCallConnect = (c: CallAgg): boolean => !c.voicemail && (c.answered || c.durationSec >= 30);

    const numMap = new Map<string, { dials: number; connects: number; connectedDurSec: number }>();
    const agentDetail = new Map<string, { dials: number; connects: number; talkTimeSec: number; sentimentSum: number; sentimentN: number }>();
    for (const c of perCall.values()) {
      const connected = isCallConnect(c);
      if (c.outbound && c.fromPhone) {
        let n = numMap.get(c.fromPhone);
        if (!n) { n = { dials: 0, connects: 0, connectedDurSec: 0 }; numMap.set(c.fromPhone, n); }
        n.dials += 1;
        if (connected) { n.connects += 1; n.connectedDurSec += c.durationSec; }
      }
      let a = agentDetail.get(c.agentEmail);
      if (!a) { a = { dials: 0, connects: 0, talkTimeSec: 0, sentimentSum: 0, sentimentN: 0 }; agentDetail.set(c.agentEmail, a); }
      a.dials += 1;
      if (connected) { a.connects += 1; a.talkTimeSec += c.durationSec; }
      if (c.sentiment !== null) { a.sentimentSum += c.sentiment; a.sentimentN += 1; }
    }
    const callNumbers: CallNumberStats[] = Array.from(numMap.entries()).map(([number, n]) => {
      const ratePct = n.dials ? (n.connects / n.dials) * 100 : 0;
      const health: CallNumberHealth =
        n.dials < 20 ? "insufficient_data" : ratePct >= 15 ? "healthy" : ratePct >= 8 ? "warning" : "critical";
      return {
        number,
        dials: n.dials,
        connects: n.connects,
        connectRatePct: Math.round(ratePct * 10) / 10,
        avgDurationSec: n.connects ? Math.round(n.connectedDurSec / n.connects) : 0,
        health,
      };
    }).sort((a, b) => b.dials - a.dials);
    const callAgents: CallAgentStats[] = Array.from(agentDetail.entries()).map(([email, a]) => ({
      email,
      name: (email && findAgentByEmail(email)?.name) || (email ? email.split("@")[0] : "unassigned"),
      dials: a.dials,
      connects: a.connects,
      talkTimeSec: a.talkTimeSec,
      avgSentiment: a.sentimentN ? Math.round((a.sentimentSum / a.sentimentN) * 100) / 100 : null,
    })).sort((a, b) => b.dials - a.dials);

    const calls: CallMetrics = {
      dials, connects,
      connectRate: dials ? connects / dials : 0,
      voicemails, talkTimeSec,
      avgTalkSec: connects ? Math.round(talkTimeSec / connects) : 0,
      perAgent: Array.from(agentMap.entries()).map(([agent, v]) => ({ agent, ...v })).sort((a, b) => b.dials - a.dials),
      dispositions: Array.from(dispMap.entries()).map(([disposition, count]) => ({ disposition, count })).sort((a, b) => b.count - a.count),
      numbers: callNumbers,
      agents: callAgents,
    };

    return {
      windowDays: win,
      bySource,
      combined,
      sms,
      calls,
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
