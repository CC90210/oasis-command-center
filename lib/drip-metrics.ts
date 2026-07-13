/**
 * lib/drip-metrics.ts — aggregation layer for the SunBiz "Metrics" tab.
 *
 * One tenant-scoped read pass over the data the drip engine + tracking routes
 * already write: drip_runs (send schedule + failure reasons), lead_interactions
 * (the real send audit trail, dry-runs excluded), email_open_events /
 * email_click_events (engagement), form_views (application interaction), and
 * email_suppressions (opt-out / bounce). No new storage — everything here is
 * derivable today (drip_runs even carries a tenant-read RLS policy added "for a
 * future ops view"). All reads go through the service-role client; the page that
 * calls this is tenant-gated.
 *
 * Opens/clicks are attributed back to a sequence + variant by joining the
 * event's outbound_message_id to the lead_interactions row id the executor
 * pinned at send time (send_id) — that is what powers the per-variant A/B and
 * per-drip funnel. Since the drip email path is currently the only sender that
 * injects the open pixel + click links, every open/click event for the tenant is
 * drip-attributable.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";

type Db = ReturnType<typeof getServiceSupabase>;

// Canonical SunBiz funnel order (forward). Branch/terminal stages
// (ghost, opted_out, dead_file, archived) are counted in total but rank 0.
const FUNNEL_ORDER = [
  "intent_inquiry_submitted",
  "hot_lead",
  "follow_up",
  "missing_info",
  "sent_application",
  "viewed_application",
  "signed_application",
  "submitted_application",
  "shopping",
  "docs_out",
  "approved",
  "funded",
];
const STAGE_RANK = new Map(FUNNEL_ORDER.map((s, i) => [s, i]));

const APPLIED_RANK = STAGE_RANK.get("viewed_application")!; // "interacted with the application"
const SIGNED_RANK = STAGE_RANK.get("signed_application")!;
const FUNDED_RANK = STAGE_RANK.get("funded")!;

export type MetricsHealth = "healthy" | "watch" | "spammy";

export type SequenceMetric = {
  sequenceName: string;
  channelMix: string; // "email" | "sms" | "email+sms"
  sent: number; // real, non-dry-run
  opened: number;
  clicked: number;
  failed: number;
  openRate: number; // 0..1 (email sends only)
  clickRate: number;
  emailSent: number;
  variants: Array<{ index: number; sent: number; opened: number; clicked: number }>;
};

export type DripMetrics = {
  windowDays: number;
  funnel: {
    total: number;
    stages: Array<{ stage: string; count: number }>; // current-state distribution, funnel order
    appliedPct: number; // reached viewed_application or beyond / total
    signedPct: number;
    fundedPct: number;
    appliedCount: number;
    signedCount: number;
    fundedCount: number;
  };
  reach: {
    emailSent: number;
    smsSent: number;
    delivered: number; // accepted by relay = emailSent - hard failures
    failed: number;
    suppressedAdded: number;
    health: MetricsHealth;
    bounceRate: number;
    complaintRate: number;
    failRate: number;
  };
  engagement: {
    opens: number; // genuine (non-prefetch)
    uniqueOpens: number;
    clicks: number;
    uniqueClicks: number;
    openRate: number;
    clickRate: number;
    formViews: number;
    clickAdvances: number; // clicks that moved a lead to viewed (leadIds clicked & now >= applied)
  };
  drips: SequenceMetric[];
  failureReasons: Array<{ reason: string; count: number }>;
  generatedAt: string;
};

function healthFrom(bounceRate: number, complaintRate: number, failRate: number): MetricsHealth {
  // In-house proxy (Postmaster spam-rate lands in Ship 2). Thresholds anchored
  // to the warm-up plan's 0.10%/0.30% complaint lines, coarser for bounce/fail.
  if (complaintRate >= 0.003 || bounceRate >= 0.05 || failRate >= 0.15) return "spammy";
  if (complaintRate >= 0.001 || bounceRate >= 0.02 || failRate >= 0.08) return "watch";
  return "healthy";
}

/** Normalize a last_error string into a coarse failure bucket for the breakdown. */
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

export async function getDripMetrics(tenantId: string, days = 30): Promise<DripMetrics> {
  const db: Db = getServiceSupabase();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const empty: DripMetrics = {
    windowDays: days,
    funnel: { total: 0, stages: [], appliedPct: 0, signedPct: 0, fundedPct: 0, appliedCount: 0, signedCount: 0, fundedCount: 0 },
    reach: { emailSent: 0, smsSent: 0, delivered: 0, failed: 0, suppressedAdded: 0, health: "healthy", bounceRate: 0, complaintRate: 0, failRate: 0 },
    engagement: { opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0, openRate: 0, clickRate: 0, formViews: 0, clickAdvances: 0 },
    drips: [],
    failureReasons: [],
    generatedAt: new Date().toISOString(),
  };
  if (!tenantId) return empty;

  try {
    const [leadsRes, runsRes, intxRes, opensRes, clicksRes, viewsRes, suppRes] = await Promise.all([
      db.from("tenant_records").select("data").eq("tenant_id", tenantId).eq("entity_type", "lead"),
      db.from("drip_runs").select("sequence_name, status, last_error, channel").eq("tenant_id", tenantId).gte("created_at", sinceIso),
      db
        .from("lead_interactions")
        .select("id, lead_id, channel, agent_source, metadata")
        .eq("tenant_id", tenantId)
        .like("agent_source", "sequence:%")
        .gte("created_at", sinceIso)
        .limit(20000),
      db.from("email_open_events").select("lead_id, outbound_message_id, suspicious_prefetch").eq("tenant_id", tenantId).gte("created_at", sinceIso).limit(20000),
      db.from("email_click_events").select("lead_id, outbound_message_id").eq("tenant_id", tenantId).gte("created_at", sinceIso).limit(20000),
      db.from("form_views").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).gte("created_at", sinceIso),
      db.from("email_suppressions").select("reason").eq("tenant_id", tenantId).gte("added_at", sinceIso),
    ]);

    // ---- Funnel (current-stage distribution) ----
    const stageCounts: Record<string, number> = {};
    let total = 0;
    let appliedCount = 0, signedCount = 0, fundedCount = 0;
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

    // ---- Send interactions → per-send map for open/click attribution ----
    type SendInfo = { seq: string; variant: number; channel: string };
    const sendById = new Map<string, SendInfo>();
    const perSeq = new Map<string, SequenceMetric>();
    let emailSent = 0, smsSent = 0;
    const seqGet = (name: string): SequenceMetric => {
      let m = perSeq.get(name);
      if (!m) {
        m = { sequenceName: name, channelMix: "", sent: 0, opened: 0, clicked: 0, failed: 0, openRate: 0, clickRate: 0, emailSent: 0, variants: [] };
        perSeq.set(name, m);
      }
      return m;
    };
    const seqChannels = new Map<string, Set<string>>();
    for (const r of (intxRes.data || []) as Array<{ id: string; lead_id: string | null; channel: string; agent_source: string; metadata: Record<string, unknown> | null }>) {
      const md = r.metadata || {};
      if (md.dry_run !== false) continue; // real sends only
      const seq = (r.agent_source || "sequence:").replace(/^sequence:/, "") || "(unnamed)";
      const variant = typeof md.variant_index === "number" ? md.variant_index : 0;
      const m = seqGet(seq);
      m.sent += 1;
      if (r.channel === "email") { emailSent += 1; m.emailSent += 1; sendById.set(r.id, { seq, variant, channel: "email" }); }
      else if (r.channel === "sms") smsSent += 1;
      if (!seqChannels.has(seq)) seqChannels.set(seq, new Set());
      seqChannels.get(seq)!.add(r.channel);
      let v = m.variants.find((x) => x.index === variant);
      if (!v) { v = { index: variant, sent: 0, opened: 0, clicked: 0 }; m.variants.push(v); }
      v.sent += 1;
    }

    // ---- Opens (genuine only) ----
    let opens = 0;
    const uniqueOpenLeads = new Set<string>();
    for (const o of (opensRes.data || []) as Array<{ lead_id: string | null; outbound_message_id: string; suspicious_prefetch: boolean | null }>) {
      if (o.suspicious_prefetch) continue;
      opens += 1;
      if (o.lead_id) uniqueOpenLeads.add(o.lead_id);
      const info = sendById.get(o.outbound_message_id);
      if (info) {
        const m = seqGet(info.seq);
        m.opened += 1;
        const v = m.variants.find((x) => x.index === info.variant);
        if (v) v.opened += 1;
      }
    }

    // ---- Clicks ----
    let clicks = 0;
    const uniqueClickLeads = new Set<string>();
    for (const c of (clicksRes.data || []) as Array<{ lead_id: string | null; outbound_message_id: string }>) {
      clicks += 1;
      if (c.lead_id) uniqueClickLeads.add(c.lead_id);
      const info = sendById.get(c.outbound_message_id);
      if (info) {
        const m = seqGet(info.seq);
        m.clicked += 1;
        const v = m.variants.find((x) => x.index === info.variant);
        if (v) v.clicked += 1;
      }
    }

    // ---- Drip run statuses → failures + per-seq failed ----
    const failReasonCounts = new Map<string, number>();
    let failedTotal = 0;
    for (const r of (runsRes.data || []) as Array<{ sequence_name: string; status: string; last_error: string | null; channel: string }>) {
      if (r.status === "failed") {
        failedTotal += 1;
        const seq = seqGet(r.sequence_name || "(unnamed)");
        seq.failed += 1;
        const bucket = failureBucket(r.last_error);
        failReasonCounts.set(bucket, (failReasonCounts.get(bucket) || 0) + 1);
      }
    }

    // finalize per-seq rates + channel mix
    for (const m of perSeq.values()) {
      m.openRate = m.emailSent ? m.opened / m.emailSent : 0;
      m.clickRate = m.emailSent ? m.clicked / m.emailSent : 0;
      m.variants.sort((a, b) => a.index - b.index);
      const chans = seqChannels.get(m.sequenceName);
      m.channelMix = chans ? Array.from(chans).sort().join("+") : "";
    }
    const drips = Array.from(perSeq.values()).sort((a, b) => b.sent - a.sent);

    // ---- Suppressions in window → bounce/complaint proxy ----
    let bounceAdded = 0, complaintAdded = 0, suppressedAdded = 0;
    for (const s of (suppRes.data || []) as Array<{ reason: string | null }>) {
      suppressedAdded += 1;
      const reason = (s.reason || "").toLowerCase();
      if (reason.includes("bounce")) bounceAdded += 1;
      else if (reason.includes("unsub") || reason.includes("opt")) complaintAdded += 1;
    }

    const bounceRate = emailSent ? bounceAdded / emailSent : 0;
    const complaintRate = emailSent ? complaintAdded / emailSent : 0;
    const failRate = emailSent + smsSent ? failedTotal / (emailSent + smsSent + failedTotal) : 0;
    const health = healthFrom(bounceRate, complaintRate, failRate);

    // "Clicks → viewed": each click fires the forward stage rule, so a click
    // from a pre-viewed lead advances it. Unique clicking merchants is the
    // honest proxy; precise per-lead attribution lands with Ship 2's conversion join.
    const clickAdvances = uniqueClickLeads.size;

    return {
      windowDays: days,
      funnel: {
        total,
        stages: funnelStages,
        appliedCount, signedCount, fundedCount,
        appliedPct: total ? appliedCount / total : 0,
        signedPct: total ? signedCount / total : 0,
        fundedPct: total ? fundedCount / total : 0,
      },
      reach: {
        emailSent, smsSent,
        delivered: Math.max(0, emailSent + smsSent - failedTotal),
        failed: failedTotal,
        suppressedAdded,
        health, bounceRate, complaintRate, failRate,
      },
      engagement: {
        opens, uniqueOpens: uniqueOpenLeads.size,
        clicks, uniqueClicks: uniqueClickLeads.size,
        openRate: emailSent ? opens / emailSent : 0,
        clickRate: emailSent ? clicks / emailSent : 0,
        formViews: viewsRes.count || 0,
        clickAdvances,
      },
      drips,
      failureReasons: Array.from(failReasonCounts.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[drip-metrics] getDripMetrics failed", err);
    return empty;
  }
}
