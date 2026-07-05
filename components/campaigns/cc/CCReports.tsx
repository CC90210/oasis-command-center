"use client";

/**
 * CCReports — account-wide Constant Contact analytics dashboard: rollup stat tiles
 * (contacts, aggregate open/click/bounce/unsubscribe rates, total sends), a sender-health
 * gauge + contact-status breakdown, and a sortable per-campaign performance table with
 * rate-bar cells. Data: /api/campaigns/constant-contact/reports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Stat, EmptyState } from "@/components/Card";
import { Donut } from "@/components/charts/Donut";

type CampaignRow = {
  campaign_id: string;
  type: string | null;
  last_sent_date: string | null;
  sends: number;
  opens: number;
  clicks: number;
  bounces: number;
  optouts: number;
  open_rate: number | null;
  click_rate: number | null;
};
type Data = {
  aggregate_percents: Record<string, number> | null;
  totals: { sends: number; opens: number; clicks: number; bounces: number; optouts: number };
  campaigns: CampaignRow[];
  contact_counts: Record<string, number> | null;
};

const rawPct = (v: number | undefined | null) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function num(o: Record<string, number> | null, ...keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

/** Rate rendered as a hairline bar with the % on top — matches CCCampaignsList's RateBar. */
function RateBar({ value }: { value: number | null }) {
  const p = value == null ? 0 : clamp(value * 100, 0, 100);
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-bg-elev">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent/50" style={{ width: `${p}%` }} />
      </div>
      <span className="w-12 text-right tabular-nums text-fg-muted">{value == null ? "—" : `${p.toFixed(1)}%`}</span>
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-bg-border bg-bg-panel p-5" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="h-2.5 w-20 rounded bg-bg-elev animate-pulse-slow" />
            <div className="mt-3 h-7 w-16 rounded bg-bg-elev animate-pulse-slow" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 flex items-center gap-4">
          <div className="h-[68px] w-[68px] rounded-full bg-bg-elev animate-pulse-slow" />
          <div className="flex-1 space-y-2">
            <div className="h-2.5 w-24 rounded bg-bg-elev animate-pulse-slow" />
            <div className="h-2.5 w-32 rounded bg-bg-elev/60 animate-pulse-slow" />
          </div>
        </div>
        <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-1.5 rounded-full bg-bg-elev animate-pulse-slow" />
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 overflow-hidden">
        <div className="h-10 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-11 border-b border-bg-border last:border-0 animate-pulse-slow" style={{ animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function CCReports() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"open_rate" | "click_rate" | "sends">("open_rate");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/reports", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.message || j?.error || "Couldn't load reports."); return; }
      setData(j as Data);
    } catch {
      setError("Network error loading reports.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => {
    const rows = [...(data?.campaigns || [])];
    rows.sort((a, b) => (Number(b[sortBy] ?? 0) - Number(a[sortBy] ?? 0)));
    return rows;
  }, [data, sortBy]);

  if (loading) return <ReportsSkeleton />;
  if (error) return <Card><div className="text-sm text-status-warm">{error}</div></Card>;
  if (!data) return <Card noPadding><EmptyState message="No report data yet." /></Card>;

  const ap = data.aggregate_percents || {};
  const cc = data.contact_counts || {};
  const contactsTotal = num(cc, "total", "total_contacts", "all_contacts") ?? 0;

  const bouncePct = Number(ap.bounce ?? 0);
  const unsubPct = Number(ap.unsubscribe ?? 0);
  const deliverabilityPct = clamp(100 - bouncePct - unsubPct, 0, 100);

  const unsubscribed = num(cc, "unsubscribed", "optout_count", "explicit_opt_out_count", "opted_out") ?? 0;
  const statusTotal = num(cc, "total", "total_contacts", "all_contacts") ?? 0;
  // ContactsCounts has no "subscribed" field — derive it from explicit+implicit+pending,
  // falling back to total-unsubscribed when those buckets aren't present.
  const explicitImplicitPending =
    (num(cc, "explicit", "explicit_count") ?? 0) +
    (num(cc, "implicit", "implicit_count") ?? 0) +
    (num(cc, "pending", "pending_count") ?? 0);
  const subscribed = explicitImplicitPending > 0 ? explicitImplicitPending : Math.max(statusTotal - unsubscribed, 0);
  const statusRows = [
    { label: "Subscribed", value: subscribed },
    { label: "Unsubscribed", value: unsubscribed },
  ];
  const hasStatusBreakdown = statusTotal > 0 && (subscribed || unsubscribed);

  const th = (key: typeof sortBy, label: string) => (
    <th className={`px-4 py-2.5 font-medium text-right cursor-pointer select-none transition-colors ${sortBy === key ? "text-fg" : "hover:text-fg-muted"}`} onClick={() => setSortBy(key)}>
      {label}{sortBy === key ? " ↓" : ""}
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Contacts" value={contactsTotal.toLocaleString()} hint={cc.unsubscribed != null ? `${Number(cc.unsubscribed).toLocaleString()} unsubscribed` : undefined} />
        <Stat label="Total sends" value={data.totals.sends.toLocaleString()} />
        <Stat label="Avg open rate" value={rawPct(ap.open)} accent />
        <Stat label="Avg click rate" value={rawPct(ap.click)} />
        <Stat label="Bounce rate" value={rawPct(ap.bounce)} />
        <Stat label="Unsubscribe rate" value={rawPct(ap.unsubscribe)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 flex items-center gap-4">
          <Donut pct={deliverabilityPct} tone="threshold" sublabel="deliverability" />
          <div className="text-[12px] text-fg-muted leading-relaxed">
            <div className="text-[10px] uppercase tracking-wide text-fg-dim mb-1">Sender health</div>
            100% minus bounce ({rawPct(ap.bounce)}) and unsubscribe ({rawPct(ap.unsubscribe)}) rates.
          </div>
        </div>

        <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 space-y-2.5">
          <div className="text-[10px] uppercase tracking-wide text-fg-dim">Contact status</div>
          {!hasStatusBreakdown ? (
            <div className="text-[12px] text-fg-dim italic">No contact-status breakdown available.</div>
          ) : (
            statusRows.map((s) => {
              const pct = statusTotal ? clamp((s.value / statusTotal) * 100, 0, 100) : 0;
              return (
                <div key={s.label} className="flex items-center gap-3 text-[12px]">
                  <span className="w-28 shrink-0 text-fg-dim">{s.label}</span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg-elev">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-accent/50" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-12 text-right tabular-nums text-fg-muted">{pct.toFixed(1)}%</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <Card noPadding><EmptyState message="No sent campaigns to report on yet." /></Card>
      ) : (
        <Card noPadding title="Per-campaign performance">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Last sent</th>
                  {th("sends", "Sends")}
                  {th("open_rate", "Open")}
                  {th("click_rate", "Click")}
                  <th className="px-4 py-2.5 font-medium text-right">Bounces</th>
                  <th className="px-4 py-2.5 font-medium text-right">Opt-outs</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.campaign_id} className="group border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/40 transition-colors">
                    <td className="px-4 py-2.5 text-fg-muted">{fmtDate(r.last_sent_date)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.sends.toLocaleString()}</td>
                    <td className="px-4 py-2.5"><RateBar value={r.open_rate} /></td>
                    <td className="px-4 py-2.5"><RateBar value={r.click_rate} /></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.bounces.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.optouts.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
