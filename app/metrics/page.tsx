import { Card, PageHeader, Stat, EmptyState, Tag } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import { getEmailMetrics, type MetricsHealth, type SequenceMetric } from "@/lib/metrics";
import type { MetricSource } from "@/lib/metrics/types";
import { EmailMetricsBlock } from "@/components/metrics/EmailMetricsBlock";
import { safe } from "@/lib/api-helpers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

function pct(v: number, digits = 1): string {
  if (!isFinite(v)) return "0%";
  return `${(v * 100).toFixed(digits)}%`;
}
const num = (v: number): string => v.toLocaleString();

const HEALTH_TONE: Record<MetricsHealth, "engaged" | "warm" | "hot"> = { healthy: "engaged", watch: "warm", spammy: "hot" };
const HEALTH_LABEL: Record<MetricsHealth, string> = { healthy: "Healthy", watch: "Watch", spammy: "Spammy" };

// Extensible source registry — add a source here + produce its EmailMetrics in
// lib/metrics and it shows up as a segment. Order = display order.
const SOURCES: Array<{ key: MetricSource; label: string; note?: string }> = [
  { key: "drips", label: "Drip campaigns" },
  { key: "cold", label: "Cold outreach" },
  { key: "submissions", label: "Submissions@", note: "Open/click instrumentation ships with the compliance pass; sends log here as it rolls out." },
  { key: "constant_contact", label: "Constant Contact" },
];

const STAGE_LABEL: Record<string, string> = {
  intent_inquiry_submitted: "Inquiry", hot_lead: "Hot lead", follow_up: "Follow-up",
  missing_info: "Missing info", sent_application: "Application sent", viewed_application: "Application viewed",
  signed_application: "Signed", submitted_application: "Statements in", shopping: "Shopping",
  docs_out: "Docs out", approved: "Approved", funded: "Funded",
};

function Bar({ label, count, max, hint }: { label: string; count: number; max: number; hint?: string }) {
  const width = max > 0 ? Math.max(2, (count / max) * 100) : 0;
  return (
    <li className="flex items-center gap-3">
      <div className="w-36 shrink-0 text-xs font-bold uppercase tracking-wider text-fg-muted truncate">{label}</div>
      <div className="flex-1 h-6 bg-bg-elev rounded-md overflow-hidden border border-bg-border">
        <div className="h-full bg-accent flex items-center px-2 text-xs font-bold text-bg" style={{ width: `${width}%` }}>
          {count > 0 && num(count)}
        </div>
      </div>
      {hint && <div className="w-14 shrink-0 text-right text-xs text-fg-dim tabular-nums">{hint}</div>}
    </li>
  );
}

function DripRow({ d }: { d: SequenceMetric }) {
  const showVariants = d.variants.length > 1;
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
      {showVariants &&
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

export default async function MetricsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await safe("metrics.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  const m = await safe("metrics.email", getEmailMetrics(tenantId, WINDOW_DAYS), null);

  if (!m) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Metrics" subtitle="Email performance across all deals." />
        <Card title="Metrics"><EmptyState message="Metrics are warming up. Check back once a cycle has run." /></Card>
      </div>
    );
  }

  const c = m.combined;
  const drip = m.drip;
  const funnelMax = drip.funnel.stages.reduce((mx, s) => Math.max(mx, s.count), 0);
  const failMax = drip.failureReasons.reduce((mx, f) => Math.max(mx, f.count), 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Metrics"
        subtitle={`Email across all sources · last ${m.windowDays} days · updated ${new Date(m.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
        action={<Tag tone={HEALTH_TONE[drip.health]}>{HEALTH_LABEL[drip.health]}</Tag>}
      />

      {/* Combined headline — Constant Contact parity across every source */}
      <Card title="All email" subtitle="Every source combined, using Constant Contact's metric definitions">
        <EmailMetricsBlock metrics={c} />
      </Card>

      {/* Per-source segments (extensible via the SOURCES registry) */}
      {SOURCES.map((s) => (
        <Card key={s.key} title={s.label} subtitle={s.note}>
          <EmailMetricsBlock metrics={m.bySource[s.key]} />
        </Card>
      ))}

      {/* Drip-specific: conversion funnel */}
      <Card title="Conversion funnel" subtitle="Where merchants sit now, and how far they get (all channels)">
        {drip.funnel.stages.length === 0 ? (
          <EmptyState message="No leads in the pipeline yet." />
        ) : (
          <>
            <ul className="space-y-2">
              {drip.funnel.stages.map((s) => (
                <Bar key={s.stage} label={STAGE_LABEL[s.stage] || s.stage} count={s.count} max={funnelMax} hint={pct(drip.funnel.total ? s.count / drip.funnel.total : 0, 0)} />
              ))}
            </ul>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 border-t border-bg-border pt-4">
              <Stat label="Reached application" value={pct(drip.funnel.appliedPct)} hint={`${num(drip.funnel.appliedCount)} of ${num(drip.funnel.total)}`} />
              <Stat label="Signed" value={pct(drip.funnel.signedPct)} />
              <Stat label="Funded" value={pct(drip.funnel.fundedPct)} />
              <Stat label="Form interactions" value={num(drip.formViews)} hint="opened the application" />
            </div>
          </>
        )}
      </Card>

      {/* Drip-specific: per-drip A/B */}
      <Card title="Per-drip performance" subtitle="Each sequence, with A/B on the copy variations">
        {drip.sequences.length === 0 ? (
          <EmptyState message="No drip sends in this window yet." />
        ) : (
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
                {drip.sequences.map((d) => <DripRow key={d.sequenceName} d={d} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Drip-specific: failures */}
      {drip.failureReasons.length > 0 && (
        <Card title="Failures" subtitle="Why drip sends didn't go out (last 30 days)">
          <ul className="space-y-2">
            {drip.failureReasons.map((f) => <Bar key={f.reason} label={f.reason} count={f.count} max={failMax} />)}
          </ul>
        </Card>
      )}
    </div>
  );
}
