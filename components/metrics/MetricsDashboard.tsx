"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Tag } from "@/components/Card";
import { Sparkline } from "@/components/charts/Sparkline";
import { Donut } from "@/components/charts/Donut";
import { TrendArea } from "@/components/metrics/TrendArea";
import type { MetricsPayload, SourceBlock, SequenceMetric, MetricsHealth } from "@/lib/metrics";
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

/* ---------------- per-drip A/B table ---------------- */
function DripTable({ sequences }: { sequences: SequenceMetric[] }) {
  if (!sequences.length) return <div className="text-sm text-fg-dim py-2">No drip sends in this window yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
            <th className="text-left font-bold pb-1">Sequence</th>
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
  return (
    <>
      <tr className="border-t border-bg-border">
        <td className="py-2.5 pr-3 text-sm font-semibold text-fg">{d.sequenceName}</td>
        <td className="py-2.5 px-2 text-xs text-fg-muted uppercase tracking-wide">{d.channelMix || "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-fg">{num(d.sent)}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{d.emailSent ? num(d.opened) : "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-fg-muted">{d.emailSent ? num(d.clicked) : "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-accent">{d.emailSent ? pct(d.openRate) : "—"}</td>
        <td className="py-2.5 px-2 text-right tabular-nums text-accent">{d.emailSent ? pct(d.clickRate) : "—"}</td>
        <td className="py-2.5 pl-2 text-right tabular-nums">{d.failed > 0 ? <span className="text-status-hot">{num(d.failed)}</span> : <span className="text-fg-dim">0</span>}</td>
      </tr>
      {d.variants.length > 1 &&
        d.variants.map((v) => (
          <tr key={`${d.sequenceName}-v${v.index}`} className="text-xs text-fg-dim">
            <td className="py-1 pr-3 pl-4">variation {String.fromCharCode(65 + v.index)}</td>
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
function SmsPanel({ smsSent, windowDays }: { smsSent: number; windowDays: number }) {
  return (
    <Card title="Text Torrent · SMS" subtitle="Your text-message channel">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <VolTile label="SMS sent" value={compact(smsSent)} hint={`via drips · last ${windowDays} days`} />
      </div>
      <p className="mt-4 text-sm text-fg-dim leading-relaxed max-w-2xl">
        SMS goes out through Text Torrent from your drip sequences. Detailed delivery, reply, and
        opt-out rates connect here once Text Torrent campaign collection is turned on. For now the
        volume above is your drip SMS; per-rep sending detail lives in the Drips tab.
      </p>
    </Card>
  );
}

function KixiePanel() {
  return (
    <Card title="Kixie" subtitle="Calling — not connected yet">
      <div className="text-center py-10">
        <div className="text-sm text-fg-muted font-semibold">Kixie isn&apos;t connected yet.</div>
        <p className="mt-2 text-sm text-fg-dim max-w-md mx-auto leading-relaxed">
          Once integrated, call metrics — dials, connects, talk time, and outcomes — will show here
          alongside your email and SMS channels.
        </p>
      </div>
    </Card>
  );
}

/* ---------------- the shell ---------------- */
export function MetricsDashboard({ payload }: { payload: MetricsPayload }) {
  const [active, setActive] = useState<TabKey>("all");
  const activeMeta = SOURCES.find((s) => s.key === active)!;
  const kind = activeMeta.kind;
  const drip = payload.drip;

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
        <div className="ml-auto text-[11px] text-fg-dim">updated {timeAgo(payload.generatedAt)}</div>
      </div>

      {kind === "sms" ? (
        <SmsPanel smsSent={drip.smsSent} windowDays={payload.windowDays} />
      ) : kind === "calls" ? (
        <KixiePanel />
      ) : !m || !block || m.sent === 0 ? (
        <Card title={activeMeta.label}>
          <div className="text-sm text-fg-dim py-6 text-center">No email sent from this source in the last {payload.windowDays} days.</div>
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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
