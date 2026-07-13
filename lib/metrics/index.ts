/**
 * lib/metrics/index.ts — the Metrics tab's aggregation. One tenant-scoped read
 * pass produces a CC-parity EmailMetrics block PER SOURCE (drips, cold,
 * submissions@, Constant Contact) + the drip-only extras (funnel, per-sequence
 * A/B, failures) + a combined "All" roll-up.
 *
 * Attribution: opens/clicks live in email_open_events / email_click_events keyed
 * by outbound_message_id = the lead_interactions row id the sender pinned
 * (send_id). We build id→source from lead_interactions.agent_source
 * ('sequence:'→drips, 'cold:'→cold, 'submissions:'→submissions) and bucket each
 * open/click through it. Constant Contact is snapshot-based (campaign_metric_
 * snapshots), never interaction-based, so it can't double-count.
 *
 * No new storage — everything derives from tables the send paths + track routes
 * already write. Reads go through the service-role client; the page is tenant-gated.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { EmailCounts, EmailMetrics, MetricSource, computeRates, emptyCounts, sumMetrics } from "./types";

type Db = ReturnType<typeof getServiceSupabase>;

// ---- Drip funnel + per-sequence extras (ported from the Ship-1 drip metrics) ----
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

export type MetricsPayload = {
  windowDays: number;
  bySource: Record<MetricSource, EmailMetrics>;
  combined: EmailMetrics;
  drip: DripExtras;
  generatedAt: string;
};

function healthFrom(bounceRate: number, complaintRate: number, failRate: number): MetricsHealth {
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

/** agent_source prefix → interaction-based MetricSource (CC is snapshot-based). */
function sourceFromAgent(agent: string): "drips" | "cold" | "submissions" | null {
  if (agent.startsWith("sequence:")) return "drips";
  if (agent.startsWith("cold:")) return "cold";
  if (agent.startsWith("submissions:")) return "submissions";
  return null;
}

/** email_suppressions row → the source to charge its bounce/unsub/complaint to.
 *  constant_contact is intentionally excluded (its numbers come from the CC
 *  snapshot, so charging suppressions too would double-count). */
function sourceFromSuppression(sourceField: string): "drips" | "cold" | "submissions" | null {
  const s = (sourceField || "").toLowerCase();
  if (s.includes("constant_contact")) return null;
  if (s.includes("smartlead") || s.startsWith("web_form:cold")) return "cold";
  if (s.includes("submissions_dsn") || s.startsWith("web_form:submissions")) return "submissions";
  if (s.startsWith("web_form")) return "drips"; // footer opt-out; drips are the primary commercial email sender
  return "submissions"; // default: the submissions@ domain
}

export async function getEmailMetrics(tenantId: string, days = 30): Promise<MetricsPayload> {
  const db: Db = getServiceSupabase();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  const mkEmpty = (): EmailMetrics => computeRates(emptyCounts());
  const empty: MetricsPayload = {
    windowDays: days,
    bySource: { drips: mkEmpty(), cold: mkEmpty(), submissions: mkEmpty(), constant_contact: mkEmpty() },
    combined: mkEmpty(),
    drip: {
      funnel: { total: 0, stages: [], appliedPct: 0, signedPct: 0, fundedPct: 0, appliedCount: 0, signedCount: 0, fundedCount: 0 },
      smsSent: 0, formViews: 0, clickAdvances: 0, sequences: [], failureReasons: [], health: "healthy",
    },
    generatedAt: new Date().toISOString(),
  };
  if (!tenantId) return empty;

  try {
    const [leadsRes, runsRes, intxRes, opensRes, clicksRes, viewsRes, suppRes, ccRunsRes] = await Promise.all([
      db.from("tenant_records").select("data").eq("tenant_id", tenantId).eq("entity_type", "lead"),
      db.from("drip_runs").select("sequence_name, status, last_error").eq("tenant_id", tenantId).gte("created_at", sinceIso),
      // NOTE: inside .or(), like-wildcards are '*' (PostgREST URL form), not '%'.
      db.from("lead_interactions").select("id, lead_id, channel, agent_source, metadata")
        .eq("tenant_id", tenantId).or("agent_source.like.sequence:*,agent_source.like.cold:*,agent_source.like.submissions:*")
        .gte("created_at", sinceIso).limit(50000),
      db.from("email_open_events").select("lead_id, outbound_message_id, suspicious_prefetch").eq("tenant_id", tenantId).gte("created_at", sinceIso).limit(50000),
      db.from("email_click_events").select("lead_id, outbound_message_id").eq("tenant_id", tenantId).gte("clicked_at", sinceIso).limit(50000),
      db.from("form_views").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).gte("created_at", sinceIso),
      db.from("email_suppressions").select("reason, source").eq("tenant_id", tenantId).gte("added_at", sinceIso),
      db.from("campaign_runs").select("tt_campaign_id").eq("tenant_id", tenantId).eq("channel", "constant_contact").gte("launched_at", sinceIso).limit(500),
    ]);

    // ---- Drip funnel (current-stage distribution) ----
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

    // ---- Interactions → per-source sent + id→source map + drip per-seq ----
    const counts: Record<"drips" | "cold" | "submissions", EmailCounts> = {
      drips: emptyCounts(), cold: emptyCounts(), submissions: emptyCounts(),
    };
    const sendSource = new Map<string, "drips" | "cold" | "submissions">();
    const uniqOpenLeads: Record<string, Set<string>> = { drips: new Set(), cold: new Set(), submissions: new Set() };
    const uniqClickLeads: Record<string, Set<string>> = { drips: new Set(), cold: new Set(), submissions: new Set() };
    const perSeq = new Map<string, SequenceMetric>();
    const seqChannels = new Map<string, Set<string>>();
    let smsSent = 0;
    const seqGet = (name: string): SequenceMetric => {
      let m = perSeq.get(name);
      if (!m) { m = { sequenceName: name, channelMix: "", sent: 0, opened: 0, clicked: 0, failed: 0, openRate: 0, clickRate: 0, emailSent: 0, variants: [] }; perSeq.set(name, m); }
      return m;
    };

    for (const r of (intxRes.data || []) as Array<{ id: string; lead_id: string | null; channel: string; agent_source: string; metadata: Record<string, unknown> | null }>) {
      const md = r.metadata || {};
      if (md.dry_run !== false) continue; // real sends only
      const src = sourceFromAgent(r.agent_source || "");
      if (!src) continue;
      if (r.channel === "email") {
        counts[src].sent += 1;
        sendSource.set(r.id, src);
      } else if (r.channel === "sms" && src === "drips") {
        smsSent += 1;
      }
      // drip per-sequence extras
      if (src === "drips") {
        const seq = (r.agent_source || "sequence:").replace(/^sequence:/, "") || "(unnamed)";
        const variant = typeof md.variant_index === "number" ? md.variant_index : 0;
        const m = seqGet(seq);
        m.sent += 1;
        if (r.channel === "email") m.emailSent += 1;
        if (!seqChannels.has(seq)) seqChannels.set(seq, new Set());
        seqChannels.get(seq)!.add(r.channel);
        let v = m.variants.find((x) => x.index === variant);
        if (!v) { v = { index: variant, sent: 0, opened: 0, clicked: 0 }; m.variants.push(v); }
        v.sent += 1;
      }
    }

    // ---- Opens (genuine) bucketed by source ----
    for (const o of (opensRes.data || []) as Array<{ lead_id: string | null; outbound_message_id: string; suspicious_prefetch: boolean | null }>) {
      if (o.suspicious_prefetch) continue;
      const src = sendSource.get(o.outbound_message_id);
      if (!src) continue;
      counts[src].opens += 1;
      if (o.lead_id) uniqOpenLeads[src].add(o.lead_id);
      if (src === "drips") {
        // attribute to the sequence + variant for the A/B table
        // (re-derive via the interaction metadata isn't available here; the
        //  per-seq open/click below is recomputed from the drip send set)
      }
    }
    // ---- Clicks bucketed by source ----
    for (const c of (clicksRes.data || []) as Array<{ lead_id: string | null; outbound_message_id: string }>) {
      const src = sendSource.get(c.outbound_message_id);
      if (!src) continue;
      counts[src].clicks += 1;
      if (c.lead_id) uniqClickLeads[src].add(c.lead_id);
    }
    for (const src of ["drips", "cold", "submissions"] as const) {
      counts[src].uniqueOpens = uniqOpenLeads[src].size;
      counts[src].uniqueClicks = uniqClickLeads[src].size;
    }

    // ---- Per-sequence open/click (drip A/B) — recompute by joining events to drip sends ----
    // Build message→(seq,variant) for drip email sends only.
    const dripMsg = new Map<string, { seq: string; variant: number }>();
    for (const r of (intxRes.data || []) as Array<{ id: string; channel: string; agent_source: string; metadata: Record<string, unknown> | null }>) {
      const md = r.metadata || {};
      if (md.dry_run !== false || r.channel !== "email" || !(r.agent_source || "").startsWith("sequence:")) continue;
      const seq = r.agent_source.replace(/^sequence:/, "") || "(unnamed)";
      dripMsg.set(r.id, { seq, variant: typeof md.variant_index === "number" ? md.variant_index : 0 });
    }
    for (const o of (opensRes.data || []) as Array<{ outbound_message_id: string; suspicious_prefetch: boolean | null }>) {
      if (o.suspicious_prefetch) continue;
      const info = dripMsg.get(o.outbound_message_id);
      if (!info) continue;
      const m = seqGet(info.seq); m.opened += 1;
      const v = m.variants.find((x) => x.index === info.variant); if (v) v.opened += 1;
    }
    for (const c of (clicksRes.data || []) as Array<{ outbound_message_id: string }>) {
      const info = dripMsg.get(c.outbound_message_id);
      if (!info) continue;
      const m = seqGet(info.seq); m.clicked += 1;
      const v = m.variants.find((x) => x.index === info.variant); if (v) v.clicked += 1;
    }

    // ---- Drip run statuses → failures ----
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

    // ---- Suppressions (30d) → bounce/unsub/complaint per interaction-based source ----
    for (const s of (suppRes.data || []) as Array<{ reason: string | null; source: string | null }>) {
      const src = sourceFromSuppression(s.source || "");
      if (!src) continue; // constant_contact handled by snapshot
      counts[src].isProxy = true;
      const reason = (s.reason || "").toLowerCase();
      if (reason.includes("bounce")) counts[src].bounces += 1;
      else if (reason.includes("abuse") || reason.includes("complaint") || reason.includes("spam")) counts[src].complaints += 1;
      else counts[src].unsubscribes += 1; // unsubscribe / opt_out
    }

    // ---- Constant Contact source: latest snapshot per CC campaign ----
    const ccCounts = emptyCounts();
    const ccIds = ((ccRunsRes.data || []) as Array<{ tt_campaign_id: string }>).map((r) => r.tt_campaign_id).filter(Boolean);
    if (ccIds.length) {
      const snapRes = await db
        .from("campaign_metric_snapshots")
        .select("tt_campaign_id, snapshot_at, delivered, opens, unique_opens, clicks, unique_clicks, bounces, optouts, complaints")
        .eq("tenant_id", tenantId)
        .in("tt_campaign_id", ccIds)
        .order("snapshot_at", { ascending: false })
        .limit(5000);
      const seen = new Set<string>();
      for (const s of (snapRes.data || []) as Array<Record<string, number | string>>) {
        const id = String(s.tt_campaign_id);
        if (seen.has(id)) continue; // latest snapshot only (desc order)
        seen.add(id);
        ccCounts.sent += Number(s.delivered || 0); // collector stores CC "sends" in the delivered column
        ccCounts.bounces += Number(s.bounces || 0);
        ccCounts.opens += Number(s.opens || 0);
        ccCounts.uniqueOpens += Number(s.unique_opens || 0);
        ccCounts.clicks += Number(s.clicks || 0);
        ccCounts.uniqueClicks += Number(s.unique_clicks || 0);
        ccCounts.unsubscribes += Number(s.optouts || 0);
        ccCounts.complaints += Number(s.complaints || 0);
      }
    }

    const bySource = {
      drips: computeRates(counts.drips),
      cold: computeRates(counts.cold),
      submissions: computeRates(counts.submissions),
      constant_contact: computeRates(ccCounts),
    };
    const combined = sumMetrics([counts.drips, counts.cold, counts.submissions, ccCounts]);

    const failRate = combined.sent + smsSent + failedTotal ? failedTotal / (combined.sent + smsSent + failedTotal) : 0;
    const health = healthFrom(bySource.drips.bounceRate, bySource.drips.complaintRate, failRate);

    return {
      windowDays: days,
      bySource,
      combined,
      drip: {
        funnel: {
          total, stages: funnelStages,
          appliedCount, signedCount, fundedCount,
          appliedPct: total ? appliedCount / total : 0,
          signedPct: total ? signedCount / total : 0,
          fundedPct: total ? fundedCount / total : 0,
        },
        smsSent,
        formViews: viewsRes.count || 0,
        clickAdvances: uniqClickLeads.drips.size,
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
