"use client";

/**
 * CCReports — account-wide Constant Contact analytics: rollup stat tiles (contacts,
 * aggregate open/click/unsubscribe rates, total sends) + a sortable per-campaign
 * performance table. Data: /api/campaigns/constant-contact/reports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Stat, EmptyState } from "@/components/Card";

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

const fracPct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
const rawPct = (v: number | undefined | null) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

  if (loading) return <Card><div className="text-sm text-fg-dim italic">Loading reports…</div></Card>;
  if (error) return <Card><div className="text-sm text-status-warm">{error}</div></Card>;
  if (!data) return <Card noPadding><EmptyState message="No report data yet." /></Card>;

  const ap = data.aggregate_percents || {};
  const cc = data.contact_counts || {};
  const contactsTotal = Number(cc.all_contacts ?? cc.subscribed ?? 0);

  const th = (key: typeof sortBy, label: string) => (
    <th className={`px-4 py-2.5 font-medium text-right cursor-pointer select-none ${sortBy === key ? "text-fg" : ""}`} onClick={() => setSortBy(key)}>
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
                  <tr key={r.campaign_id} className="border-b border-bg-border/40 last:border-b-0">
                    <td className="px-4 py-2.5 text-fg-muted">{fmtDate(r.last_sent_date)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.sends.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg">{fracPct(r.open_rate)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg">{fracPct(r.click_rate)}</td>
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
