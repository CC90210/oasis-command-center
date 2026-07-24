"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag } from "@/components/Card";
import { Sparkline } from "@/components/charts/Sparkline";
import { Donut } from "@/components/charts/Donut";
import { TrendArea } from "@/components/metrics/TrendArea";
import { DripTrackerClient } from "@/components/drips/DripTrackerClient";
import type { MetricsPayload, SourceBlock, SequenceMetric, MetricsHealth, SmsMetrics, CallMetrics, CallNumberHealth } from "@/lib/metrics";
import type { EmailMetrics, MetricSource } from "@/lib/metrics/types";

/* ---------------- formatting ---------------- */
const compact = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(n).toLocaleString();
};
const num = (n: number): string => Math.round(n).toLocaleString();
const pct = (v: number, d = 1): string => (isFinite(v) ? `${(v * 100).toFixed(d)}%` : "0%");

/* ---------------- count-up (rAF, respects reduced-motion) ---------------- */
function useCountUp(to: number, ms = 850): number {
  const [v, setV] = useState(to);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setV(to); return; }
    let raf = 0;
    const start = performance.now();
    setV(0);
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setV(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return v;
}

/* ---------------- source/channel registry ---------------- */
// Tabs are the channels we actually use. Email sources (drips/cold/constant_
// contact) map to a data block; Text Torrent (SMS) + Kixie (calls) render their
// own panels — Text Torrent shows drip SMS volume today (full campaign metrics
// connect when TT collection is on); Kixie is awaiting integration.
type TabKey = "all" | "drips" | "cold" | "texttorrent" | "constant_contact" | "kixie";
const SOURCES: Array<{ key: TabKey; label: string; kind: "email" | "sms" | "calls" }> = [
  { key: "all", label: "All", kind: "email" },
  { key: "drips", label: "Drips", kind: "email" },
  { key: "cold", label: "Cold", kind: "email" },
  { key: "texttorrent", label: "Text Torrent", kind: "sms" },
  { key: "constant_contact", label: "Constant Contact", kind: "email" },
  { key: "kixie", label: "Kixie", kind: "calls" },
];

const HEALTH_TONE: Record<MetricsHealth, "engaged" | "warm" | "hot"> = { healthy: "engaged", watch: "warm", spammy: "hot" };
const HEALTH_LABEL: Record<MetricsHealth, string> = { healthy: "Healthy", watch: "Watch", spammy: "Spammy" };

const STAGE_LABEL: Record<string, string> = {
  intent_inquiry_submitted: "Inquiry", hot_lead: "Hot lead", follow_up: "Follow-up",
  missing_info: "Missing info", sent_application: "Application sent", viewed_application: "Application viewed",
  signed_application: "Signed", submitted_application: "Statements in", shopping: "Shopping",
  docs_out: "Docs out", approved: "Approved", funded: "Funded",
};

/* ---------------- KPI card (number + delta + sparkline) ---------------- */
function KpiCard({ label, rate, prevRate, hasPrev, spark, primary }: {
  label: string; rate: number; prevRate: number; hasPrev: boolean; spark: number[]; primary?: boolean;
}) {
  const animated = useCountUp(rate * 100);
  const deltaPp = (rate - prevRate) * 100;
  const up = deltaPp > 0.05, down = deltaPp < -0.05;
  return (
    <div className={`rounded-xl border border-bg-border bg-bg-panel p-4 shadow-card transition-all ${primary ? "card-glow" : "hover:border-accent/30"}`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">{label}</div>
        {hasPrev && (up || down) && (
          <span className={`text-[10px] font-bold tabular-nums ${up ? "text-status-engaged" : "text-status-hot"}`}>
            {up ? "▲" : "▼"} {Math.abs(deltaPp).toFixed(1)}pp
          </span>
        )}
      </div>
      <div className={`mt-2 text-3xl font-bold tracking-tight tabular-nums ${primary ? "text-accent drop-shadow-[0_0_10px_rgba(59,130,246,0.35)]" : "text-fg"}`}>
        {animated.toFixed(1)}<span className="text-lg text-fg-muted">%</span>
      </div>
      <div className={`mt-2 h-[26px] ${primary ? "text-accent" : "text-fg-dim"}`}>
        <Sparkline values={spark.length > 1 ? spark : [0, 0]} width={160} height={26} area className="w-full" />
      </div>
    </div>
  );
}

/* ---------------- health gauge (reuses Donut) ---------------- */
function HealthGauge({ score, label }: { score: number; label: MetricsHealth }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel p-4 shadow-ironman flex flex-col items-center justify-center gap-2">
      <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">Deliverability</div>
      <Donut pct={score} size={116} stroke={9} tone="threshold" label={String(score)} sublabel="score" />
      <Tag tone={HEALTH_TONE[label]}>{HEALTH_LABEL[label]}</Tag>
    </div>
  );
}

/* ---------------- volume strip ---------------- */
function VolTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-deep/50 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-fg">{value}</div>
      {hint && <div className="text-[11px] text-fg-dim mt-0.5">{hint}</div>}
    </div>
  );
}

/* ---------------- interactive funnel ---------------- */
function MetricsFunnel({ stages, total }: { stages: Array<{ stage: string; count: number }>; total: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = stages.reduce((m, s) => Math.max(m, s.count), 0) || 1;
  if (!stages.length) return <div className="text-sm text-fg-dim py-4">No leads in the pipeline yet.</div>;
  return (
    <ul className="space-y-1.5">
      {stages.map((s, i) => {
        const w = Math.max(3, (s.count / max) * 100);
        const share = total ? (s.count / total) * 100 : 0;
        const retained = i > 0 && stages[i - 1].count ? (s.count / stages[i - 1].count) * 100 : null;
        const active = hover === i;
        return (
          <li key={s.stage} className="relative" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className="flex items-center gap-3">
              <div className="w-32 shrink-0 text-xs font-semibold text-fg-muted truncate">{STAGE_LABEL[s.stage] || s.stage}</div>
              <div className="flex-1 h-7 rounded-md bg-bg-elev overflow-hidden border border-bg-border">
                <div className={`h-full flex items-center px-2 text-xs font-bold text-bg transition-all ${active ? "bg-accent" : "bg-accent/80"}`} style={{ width: `${w}%` }}>
                  {num(s.count)}
                </div>
              </div>
              <div className="w-12 shrink-0 text-right text-xs text-fg-dim tabular-nums">{share.toFixed(0)}%</div>
            </div>
            {active && retained !== null && (
              <div className="absolute right-14 -top-1 z-10 rounded-md border border-bg-border bg-bg-panel px-2 py-1 text-[10px] text-fg-muted shadow-elev tabular-nums">
                {retained.toFixed(0)}% from {STAGE_LABEL[stages[i - 1].stage] || stages[i - 1].stage}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- per-source comparison ---------------- */
function SourceBarList({ bySource }: { bySource: Record<MetricSource, SourceBlock> }) {
  const rows = (["drips", "cold", "constant_contact"] as MetricSource[])
    .map((k) => ({ key: k, label: SOURCES.find((s) => s.key === k)?.label || k, m: bySource[k].metrics }))
    .filter((r) => r.m.sent > 0)
    .sort((a, b) => b.m.openRate - a.m.openRate);
  if (!rows.length) return <div className="text-sm text-fg-dim py-2">No email sent across sources yet.</div>;
  const maxRate = rows.reduce((mx, r) => Math.max(mx, r.m.openRate), 0) || 1;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3">
          <div className="w-28 shrink-0 text-xs font-semibold text-fg-muted truncate">{r.label}</div>
          <div className="flex-1 h-5 rounded bg-bg-elev overflow-hidden border border-bg-border">
            <div className="h-full bg-accent/80" style={{ width: `${Math.max(3, (r.m.openRate / maxRate) * 100)}%` }} />
          </div>
          <div className="w-16 shrink-0 text-right text-xs tabular-nums text-accent">{pct(r.m.openRate)}</div>
          <div className="w-16 shrink-0 text-right text-[11px] tabular-nums text-fg-dim">{compact(r.m.sent)} sent</div>
        </li>
      ))}
    </ul>
  );
}

/* ---------------- per-drip table: every email by STAGE + effectiveness ---------------- */
function HealthDot({ h }: { h: "ok" | "watch" | "low" }) {
  const c = h === "low" ? "bg-status-hot" : h === "watch" ? "bg-status-warm" : "bg-status-engaged";
  const label = h === "low" ? "Low open rate — may be spam-foldered, consider rotating" : h === "watch" ? "Opens below benchmark" : "Healthy";
  return <span title={label} className={`inline-block w-1.5 h-1.5 rounded-full ${c} align-middle ml-1`} />;
}
function DripTable({ sequences }: { sequences: SequenceMetric[] }) {
  if (!sequences.length) return <div className="text-sm text-fg-dim py-2">No drip sends in this window yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
            <th className="text-left font-bold pb-1">Stage</th>
            <th className="text-left font-bold pb-1 px-2">Email</th>
            <th className="text-left font-bold pb-1 px-2">Ch</th>
            <th className="text-right font-bold pb-1 px-2">Sent</th>
            <th className="text-right font-bold pb-1 px-2">Opens</th>
            <th className="text-right font-bold pb-1 px-2">Clicks</th>
            <th className="text-right font-bold pb-1 px-2">Open %</th>
            <th className="text-right font-bold pb-1 px-2">Click %</th>
            <th className="text-right font-bold pb-1 pl-2">Fail</th>
          </tr>
        </thead>
        <tbody>
          {sequences.map((d) => (
            <SeqRows key={d.sequenceName} d={d} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
function SeqRows({ d }: { d: SequenceMetric }) {
  const openTone = d.health === "low" ? "text-status-hot" : d.health === "watch" ? "text-status-warm" : "text-accent";
  return (
    <>
      <tr className="border-t border-bg-border align-top">
        <td className="py-2.5 pr-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-fg-muted">{d.stage ? d.stage.replace(/_/g, " ") : "—"}</span>
        </td>
        <td className="py-2.5 px-2 max-w-[300px]">
          <div className="text-[13px] font-medium text-fg truncate" title={d.emailSubject || undefined}>
            {d.emailSubject || <span className="text-fg-dim italic">no email step (SMS only)</span>}
          </div>
          <div className="text-[10.5px] text-fg-dim truncate">{d.sequenceName}</div>
        </td>
        <td className="py-2.5 px-2 text-xs text-fg-muted uppercase tracking-wide">{d.channelMix || "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-fg">{num(d.sent)}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{d.emailSent ? num(d.opened) : "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{d.emailSent ? num(d.clicked) : "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">
          {d.emailSent ? <span className={openTone}>{pct(d.openRate)}<HealthDot h={d.health} /></span> : "—"}
        </td>
        <td className="py-2.5 px-2 text-right tabular-nums text-accent">{d.emailSent ? pct(d.clickRate) : "—"}</td>
        <td className="py-2.5 pl-2 text-right tabular-nums">{d.failed > 0 ? <span className="text-status-hot">{num(d.failed)}</span> : <span className="text-fg-dim">0</span>}</td>
      </tr>
      {d.variants.length > 1 &&
        d.variants.map((v) => (
          <tr key={`${d.sequenceName}-v${v.index}`} className="text-xs text-fg-dim">
            <td />
            <td className="py-1 px-2 pl-4">variation {String.fromCharCode(65 + v.index)}</td>
            <td className="py-1 px-2" />
            <td className="py-1 px-2 text-right tabular-nums">{num(v.sent)}</td>
            <td className="py-1 px-2 text-right tabular-nums">{num(v.opened)}</td>
            <td className="py-1 px-2 text-right tabular-nums">{num(v.clicked)}</td>
            <td className="py-1 px-2 text-right tabular-nums">{v.sent ? pct(v.opened / v.sent) : "—"}</td>
            <td className="py-1 px-2 text-right tabular-nums">{v.sent ? pct(v.clicked / v.sent) : "—"}</td>
            <td className="py-1 pl-2" />
          </tr>
        ))}
    </>
  );
}

/* ---------------- Text Torrent (SMS) + Kixie (calls) panels ---------------- */
function numHealthTone(h: string): "hot" | "warm" | "engaged" {
  return h === "spammy" ? "hot" : h === "watch" ? "warm" : "engaged";
}
type TtLive = {
  credits: number | null; plan: number | null; subAccounts: number | null; company: string | null;
  campaigns: Array<{ id: string; name: string; status: string; createdAt: string; list: string }>;
};
function SmsPanel({ sms, windowDays }: { sms: SmsMetrics; windowDays: number }) {
  const hasCampaigns = sms.campaignSent > 0;
  // Live account snapshot (credits + recent campaigns), fetched only when this
  // tab mounts so we don't hit the shared TT rate limit on every page load.
  const [live, setLive] = useState<TtLive | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/metrics/tt-live")
      .then((r) => r.json())
      .then((d) => { if (alive && d?.ok) setLive(d as TtLive); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return (
    <div className="space-y-6">
      {/* live account line */}
      {live && (live.credits != null || live.subAccounts != null) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-fg-muted">
          {live.credits != null && (
            <span><span className="text-fg font-bold tabular-nums text-sm">{compact(live.credits)}</span> credits</span>
          )}
          {live.subAccounts != null && <span className="text-fg-dim">{live.subAccounts} sub-accounts (reps)</span>}
          {live.company && <span className="text-fg-dim">{live.company}</span>}
          <span className="ml-auto text-fg-dim">live from Text Torrent</span>
        </div>
      )}
      {/* headline SMS stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <VolTile label="SMS sent" value={compact(sms.totalSent)} hint={`${compact(sms.dripSent)} via drips`} />
        <VolTile label="Delivered" value={hasCampaigns ? compact(sms.delivered) : "—"} hint={hasCampaigns ? pct(sms.deliveryRate) : "campaigns"} />
        <VolTile label="Failed" value={hasCampaigns ? compact(sms.failed) : "—"} hint={hasCampaigns ? pct(sms.failed / sms.campaignSent) : ""} />
        <VolTile label="Delivery rate" value={hasCampaigns ? pct(sms.deliveryRate) : "—"} />
        <VolTile label="Replies in" value={compact(sms.repliesReceived)} hint={`inbound · ${windowDays}d`} />
        <VolTile label="Reply rate" value={hasCampaigns ? pct(sms.replyRate) : "—"} hint={hasCampaigns ? "campaigns" : ""} />
      </div>

      {sms.dripDeliveryChecked > 0 && (
        <div className="text-xs text-fg-dim">
          Real per-message delivery (sampled from {num(sms.dripDeliveryChecked)} texts with a carrier status):{" "}
          <span className="text-fg font-semibold tabular-nums">{pct(1 - sms.dripDeliveryFailed / sms.dripDeliveryChecked)}</span> delivered,{" "}
          <span className="text-status-hot font-semibold tabular-nums">{num(sms.dripDeliveryFailed)}</span> failed.
        </div>
      )}

      {/* per-number health — the key SMS signal */}
      <Card title="Number health" subtitle="Delivery + failure rate per Text Torrent sending number. Rotate anything flagged spammy.">
        {sms.numbers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="text-left font-bold pb-1">Number</th>
                  <th className="text-right font-bold pb-1 px-2">Sent</th>
                  <th className="text-right font-bold pb-1 px-2">Delivered</th>
                  <th className="text-right font-bold pb-1 px-2">Failed</th>
                  <th className="text-right font-bold pb-1 px-2">Failure</th>
                  <th className="text-right font-bold pb-1 px-2">Replies</th>
                  <th className="text-right font-bold pb-1 pl-2">Health</th>
                </tr>
              </thead>
              <tbody>
                {sms.numbers.map((n) => (
                  <tr key={n.number} className="border-t border-bg-border">
                    <td className="py-2.5 pr-3 font-semibold text-fg tabular-nums">{n.number}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg">{num(n.sent)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{num(n.delivered)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{num(n.failed)}</td>
                    <td className={`py-2.5 px-2 text-right tabular-nums font-semibold ${n.failureRate >= 20 ? "text-status-hot" : n.failureRate >= 10 ? "text-status-warm" : "text-fg-muted"}`}>{n.failureRate.toFixed(1)}%</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{num(n.replies)}</td>
                    <td className="py-2.5 pl-2 text-right"><Tag tone={numHealthTone(n.health)}>{n.health}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-sm text-fg-dim py-2">No campaign number-health data yet — it appears once the outreach collector has a Text Torrent campaign to read.</div>
        )}
      </Card>

      {/* recent campaigns (live from TT) */}
      {live && live.campaigns.length > 0 && (
        <Card title="Recent campaigns" subtitle="Live from Text Torrent">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="text-left font-bold pb-1">Campaign</th>
                  <th className="text-left font-bold pb-1 px-2">List</th>
                  <th className="text-left font-bold pb-1 px-2">Status</th>
                  <th className="text-right font-bold pb-1 pl-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {live.campaigns.map((c) => (
                  <tr key={c.id} className="border-t border-bg-border">
                    <td className="py-2 pr-3 font-semibold text-fg">{c.name}</td>
                    <td className="py-2 px-2 text-fg-muted truncate max-w-[200px]">{c.list || "—"}</td>
                    <td className="py-2 px-2"><Tag tone={c.status === "Completed" ? "engaged" : "neutral"}>{c.status || "—"}</Tag></td>
                    <td className="py-2 pl-2 text-right text-xs text-fg-dim tabular-nums">{c.createdAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* per-rep drip volume */}
      {sms.perRep.length > 0 && (
        <Card title="Drip SMS by rep" subtitle={`Per-rep 1:1 texts sent · last ${windowDays} days`}>
          <ul className="space-y-2.5">
            {sms.perRep.map((r) => {
              const max = sms.perRep[0].sent || 1;
              return (
                <li key={r.rep} className="flex items-center gap-3">
                  <div className="w-24 shrink-0 text-xs font-semibold text-fg-muted capitalize truncate">{r.rep}</div>
                  <div className="flex-1 h-5 rounded bg-bg-elev overflow-hidden border border-bg-border">
                    <div className="h-full bg-accent/80" style={{ width: `${Math.max(3, (r.sent / max) * 100)}%` }} />
                  </div>
                  <div className="w-14 shrink-0 text-right text-xs tabular-nums text-fg">{num(r.sent)}</div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <p className="text-xs text-fg-dim leading-relaxed max-w-2xl">
        Delivery, failure, and reply rates come from Text Torrent&apos;s campaign analytics (real API data). Per-rep drip texts are 1:1 sends —
        counted as volume, since Text Torrent doesn&apos;t return a per-message delivery receipt for those. A number flagged{" "}
        <span className="text-status-hot font-semibold">spammy</span> is burning deliverability and should be rotated out.
      </p>
    </div>
  );
}

function fmtDuration(sec: number): string {
  if (!sec) return "0s";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
/** Talk-time in h/m for the per-agent table ("1h 24m", "38m", "45s"). */
function fmtTalkHM(sec: number): string {
  if (!sec) return "0m";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(sec)}s`;
}
const CALL_HEALTH_META: Record<CallNumberHealth, { dot: string; label: string; text: string }> = {
  healthy: { dot: "bg-status-engaged", label: "Healthy", text: "text-status-engaged" },
  warning: { dot: "bg-status-warm", label: "Warning", text: "text-status-warm" },
  critical: { dot: "bg-status-hot", label: "Critical", text: "text-status-hot" },
  insufficient_data: { dot: "bg-fg-dim", label: "Low volume", text: "text-fg-dim" },
};
/** CI sentiment cell: avg of +1/0/-1 per call → ↑ / → / ↓. */
function SentimentCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-fg-dim">—</span>;
  if (v > 0.2) return <span className="text-status-engaged font-semibold">↑ {v.toFixed(2)}</span>;
  if (v < -0.2) return <span className="text-status-hot font-semibold">↓ {v.toFixed(2)}</span>;
  return <span className="text-fg-muted">→ {v.toFixed(2)}</span>;
}
function KixiePanel({ calls, windowDays }: { calls: CallMetrics; windowDays: number }) {
  if (calls.dials === 0) {
    return (
      <Card title="Kixie · Calls" subtitle="Calling channel">
        <div className="py-8 text-center space-y-2">
          <div className="text-sm text-fg-muted font-semibold">Ready — awaiting your first calls.</div>
          <p className="text-sm text-fg-dim max-w-lg mx-auto leading-relaxed">
            The Kixie webhook receiver is wired. Once the API key is added and the webhooks are synced,
            every dial, connect, voicemail, and disposition lands here — dials, connect rate, talk time,
            and a per-agent breakdown, live from Kixie.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <VolTile label="Dials" value={compact(calls.dials)} hint={`last ${windowDays}d`} />
        <VolTile label="Connects" value={compact(calls.connects)} hint={pct(calls.connectRate)} />
        <VolTile label="Connect rate" value={pct(calls.connectRate)} />
        <VolTile label="Talk time" value={fmtDuration(calls.talkTimeSec)} />
        <VolTile label="Avg talk" value={fmtDuration(calls.avgTalkSec)} />
        <VolTile label="Voicemails" value={compact(calls.voicemails)} />
      </div>

      {/* per-number health — the key voice-deliverability signal */}
      {calls.numbers.length > 0 && (
        <Card title="Number health" subtitle="Outbound connect rate per Kixie caller ID. Rotate anything critical.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="text-left font-bold pb-1">Number</th>
                  <th className="text-right font-bold pb-1 px-2">Dials</th>
                  <th className="text-right font-bold pb-1 px-2">Connects</th>
                  <th className="text-right font-bold pb-1 px-2">Connect %</th>
                  <th className="text-right font-bold pb-1 px-2">Avg duration</th>
                  <th className="text-right font-bold pb-1 pl-2">Health</th>
                </tr>
              </thead>
              <tbody>
                {calls.numbers.map((n) => {
                  const h = CALL_HEALTH_META[n.health];
                  return (
                    <tr key={n.number} className="border-t border-bg-border">
                      <td className="py-2.5 pr-3 font-semibold text-fg tabular-nums">{n.number}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-fg">{num(n.dials)}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{num(n.connects)}</td>
                      <td className={`py-2.5 px-2 text-right tabular-nums font-semibold ${n.health === "insufficient_data" ? "text-fg-muted" : h.text}`}>{n.connectRatePct.toFixed(1)}%</td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{n.avgDurationSec ? fmtDuration(n.avgDurationSec) : "—"}</td>
                      <td className="py-2.5 pl-2 text-right whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${h.text}`}>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${h.dot}`} />
                          {h.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-fg-dim leading-relaxed">
            A connect = Kixie reported the call answered, or it ran 30s+. Numbers under 20 dials in the window show as{" "}
            <span className="text-fg-muted font-semibold">low volume</span> — not enough data to flag either way.
          </p>
        </Card>
      )}

      {calls.agents.length > 0 && (
        <Card title="Per-agent" subtitle="Dials, connects, talk time + CI sentiment per rep">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="text-left font-bold pb-1">Agent</th>
                  <th className="text-right font-bold pb-1 px-2">Dials</th>
                  <th className="text-right font-bold pb-1 px-2">Connects</th>
                  <th className="text-right font-bold pb-1 px-2">Conn %</th>
                  <th className="text-right font-bold pb-1 px-2">Talk</th>
                  <th className="text-right font-bold pb-1 pl-2">Sentiment</th>
                </tr>
              </thead>
              <tbody>
                {calls.agents.map((a) => (
                  <tr key={a.email || a.name} className="border-t border-bg-border">
                    <td className="py-2.5 pr-3 font-semibold text-fg capitalize" title={a.email || undefined}>{a.name}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg">{num(a.dials)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{num(a.connects)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-accent">{pct(a.dials ? a.connects / a.dials : 0)}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{fmtTalkHM(a.talkTimeSec)}</td>
                    <td className="py-2.5 pl-2 text-right tabular-nums"><SentimentCell v={a.avgSentiment} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {calls.dispositions.length > 0 && (
        <Card title="Dispositions" subtitle="Call outcomes logged by reps">
          <ul className="space-y-2">
            {calls.dispositions.map((d, i) => {
              const max = calls.dispositions[0].count || 1;
              return (
                <li key={d.disposition} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 text-xs font-bold uppercase tracking-wider text-fg-muted truncate">{d.disposition}</div>
                  <div className="flex-1 h-5 rounded bg-bg-elev overflow-hidden border border-bg-border">
                    <div className={`h-full ${i === 0 ? "bg-accent" : "bg-accent/70"}`} style={{ width: `${Math.max(3, (d.count / max) * 100)}%` }} />
                  </div>
                  <div className="w-10 shrink-0 text-right text-xs tabular-nums text-fg-muted">{num(d.count)}</div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ---------------- the shell ---------------- */
export function MetricsDashboard({ payload: initialPayload }: { payload: MetricsPayload }) {
  const [payload, setPayload] = useState(initialPayload);
  const [days, setDays] = useState(initialPayload.windowDays);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<TabKey>("all");
  const activeMeta = SOURCES.find((s) => s.key === active)!;
  const kind = activeMeta.kind;
  const drip = payload.drip;

  const changeRange = (d: number) => {
    if (d === days || loading) return;
    setDays(d);
    setLoading(true);
    fetch(`/api/metrics/data?days=${d}`)
      .then((r) => r.json())
      .then((j) => { if (j?.ok && j.payload) setPayload(j.payload as MetricsPayload); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  // Email tabs map to a data block; SMS (Text Torrent) + calls (Kixie) render their own panels.
  const block: SourceBlock | null =
    kind !== "email" ? null : active === "all" ? payload.combined : payload.bySource[active as MetricSource];
  const m: EmailMetrics | null = block ? block.metrics : null;
  const p: EmailMetrics | null = block ? block.previous : null;
  const hasPrev = !!p && p.sent > 0;
  const showDripExtras = active === "all" || active === "drips";

  const kpis = block && m && p ? [
    { label: "Delivery rate", rate: m.deliveryRate, prev: p.deliveryRate, spark: block.trend.map((t) => t.sent), primary: false },
    { label: "Open rate", rate: m.openRate, prev: p.openRate, spark: block.trend.map((t) => t.opens), primary: true },
    { label: "Click rate", rate: m.clickRate, prev: p.clickRate, spark: block.trend.map((t) => t.clicks), primary: false },
    { label: "Click-to-open", rate: m.ctor, prev: p.ctor, spark: block.trend.map((t) => t.clicks), primary: false },
  ] : [];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* control bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-bg-border bg-bg-deep/50 p-1">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              onClick={() => setActive(s.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all ${
                active === s.key ? "bg-accent text-bg shadow-glow" : "text-fg-muted hover:text-fg hover:bg-bg-hover"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {m?.isProxy && <Tag tone="warm">bounce/opt-out = proxy</Tag>}
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex gap-1 rounded-lg border border-bg-border bg-bg-deep/50 p-0.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => changeRange(d)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold tabular-nums transition-all ${days === d ? "bg-accent text-bg" : "text-fg-muted hover:text-fg hover:bg-bg-hover"}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={() => exportCsv(payload)}
            title="Export CSV"
            className="px-2.5 py-1 rounded-md text-[11px] font-bold text-fg-muted border border-bg-border hover:text-fg hover:bg-bg-hover transition-all"
          >
            CSV
          </button>
          <div className="text-[11px] text-fg-dim min-w-[68px] text-right">{loading ? "updating…" : `updated ${timeAgo(payload.generatedAt)}`}</div>
        </div>
      </div>

      {active === "drips" && <DripTrackerClient />}

      {kind === "sms" ? (
        <SmsPanel sms={payload.sms} windowDays={payload.windowDays} />
      ) : kind === "calls" ? (
        <KixiePanel calls={payload.calls} windowDays={payload.windowDays} />
      ) : !m || !block || m.sent === 0 ? (
        <Card title={activeMeta.label}>
          {active === "cold" ? (
            <div className="py-8 text-center space-y-2">
              <div className="text-sm text-fg-muted font-semibold">Cold outreach is set up and ready.</div>
              <p className="text-sm text-fg-dim max-w-lg mx-auto leading-relaxed">
                Cold email sends from dedicated cold mailboxes (kept separate from your primary domain to protect its reputation),
                with open + click tracking and one-click unsubscribe already wired in. Full metrics — delivery, opens, clicks,
                bounces, unsubscribes — appear here the moment you run a cold blast.
              </p>
            </div>
          ) : (
            <div className="text-sm text-fg-dim py-6 text-center">No email sent from this source in the last {payload.windowDays} days.</div>
          )}
        </Card>
      ) : (
        <>
          {/* hero: KPI cards + health gauge */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {kpis.map((k) => (
              <KpiCard key={k.label} label={k.label} rate={k.rate} prevRate={k.prev} hasPrev={hasPrev} spark={k.spark} primary={k.primary} />
            ))}
            <HealthGauge score={block.healthScore} label={drip.health} />
          </div>

          {/* volume strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <VolTile label="Sent" value={compact(m.sent)} hint={`${pct(m.deliveryRate)} delivered`} />
            <VolTile label="Delivered" value={compact(m.delivered)} hint={`${compact(m.bounces)} bounced`} />
            <VolTile label="Opens" value={compact(m.opens)} hint={`${compact(m.uniqueOpens)} unique`} />
            <VolTile label="Clicks" value={compact(m.clicks)} hint={`${compact(m.uniqueClicks)} unique`} />
          </div>

          {/* trend */}
          <Card title="Send & engagement trend" subtitle={`Daily sent / opens / clicks · last ${payload.windowDays} days`}>
            <TrendArea data={block.trend} />
          </Card>
        </>
      )}

      {/* per-source comparison — email views only */}
      {kind === "email" && (
        <Card title="By source" subtitle="Open rate across every email source">
          <SourceBarList bySource={payload.bySource} />
        </Card>
      )}

      {/* drip-only: funnel */}
      {showDripExtras && (
        <Card title="Conversion funnel" subtitle="Where merchants sit now, and how far they get (hover a stage)">
          <MetricsFunnel stages={drip.funnel.stages} total={drip.funnel.total} />
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 border-t border-bg-border pt-4">
            <VolTile label="Reached application" value={pct(drip.funnel.appliedPct)} hint={`${num(drip.funnel.appliedCount)} of ${num(drip.funnel.total)}`} />
            <VolTile label="Signed" value={pct(drip.funnel.signedPct)} />
            <VolTile label="Funded" value={pct(drip.funnel.fundedPct)} />
            <VolTile label="Form interactions" value={compact(drip.formViews)} hint="opened the application" />
          </div>
        </Card>
      )}

      {/* drip-only: A/B + failures */}
      {showDripExtras && (
        <Card title="Per-drip performance" subtitle="Each sequence, with A/B on the copy variations">
          <DripTable sequences={drip.sequences} />
        </Card>
      )}
      {showDripExtras && drip.failureReasons.length > 0 && (
        <Card title="Failures" subtitle="Why drip sends didn't go out (last 30 days)">
          <ul className="space-y-2">
            {drip.failureReasons.map((f, i) => {
              const max = drip.failureReasons[0].count || 1;
              return (
                <li key={f.reason} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 text-xs font-bold uppercase tracking-wider text-fg-muted truncate">{f.reason}</div>
                  <div className="flex-1 h-5 rounded bg-bg-elev overflow-hidden border border-bg-border">
                    <div className={`h-full ${i === 0 ? "bg-status-hot/70" : "bg-status-warm/60"}`} style={{ width: `${Math.max(3, (f.count / max) * 100)}%` }} />
                  </div>
                  <div className="w-10 shrink-0 text-right text-xs tabular-nums text-fg-muted">{num(f.count)}</div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function exportCsv(payload: MetricsPayload) {
  const head = ["source", "sent", "delivered", "delivery_rate", "opens", "unique_opens", "open_rate", "clicks", "unique_clicks", "click_rate", "ctor", "bounces", "bounce_rate", "unsubscribes", "complaints"];
  const rows: string[][] = [head];
  const add = (label: string, m: EmailMetrics) =>
    rows.push([label, m.sent, m.delivered, m.deliveryRate, m.opens, m.uniqueOpens, m.openRate, m.clicks, m.uniqueClicks, m.clickRate, m.ctor, m.bounces, m.bounceRate, m.unsubscribes, m.complaints].map(String));
  add("all", payload.combined.metrics);
  (["drips", "cold", "constant_contact"] as MetricSource[]).forEach((k) => add(k, payload.bySource[k].metrics));
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `metrics-${payload.windowDays}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
