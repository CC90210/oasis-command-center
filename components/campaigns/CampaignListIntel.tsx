"use client";

/**
 * CampaignListIntel — the List Intelligence view: contact lists ranked by
 * conversion, dead lists flagged. Reads /api/campaigns/lists/intelligence
 * (maintained by the outreach-intel collector). Instant; no live TT.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState } from "@/components/Card";

type ListRow = {
  list_id: string;
  list_name: string | null;
  campaigns_count: number | null;
  total_sent: number | null;
  total_replies: number | null;
  total_conversions: number | null;
  reply_rate: number | null;
  conversion_rate: number | null;
  score: number | null;
  verdict: string | null;
  last_campaign_at: string | null;
};

function verdictPill(v: string | null) {
  const s = (v || "").toLowerCase();
  if (s === "recommended") return { label: "recommended", cls: "bg-emerald-500/15 text-emerald-300" };
  if (s === "dead") return { label: "dead", cls: "bg-red-500/20 text-red-300" };
  return { label: v || "average", cls: "bg-bg-deep text-fg-muted" };
}
const num = (n: number | null | undefined) => (typeof n === "number" ? n : "—");
const pct = (n: number | null | undefined) => (typeof n === "number" ? `${n}%` : "—");

export function CampaignListIntel() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ListRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/lists/intelligence");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.message || data?.error || "Couldn't load list intelligence.");
        return;
      }
      setRows(data.lists || []);
    } catch {
      setError("Network error loading list intelligence.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Card noPadding><div className="p-6 text-sm text-fg-dim">Loading list intelligence…</div></Card>;
  if (error) return <Card><div className="text-sm text-fg-muted">{error}</div></Card>;
  if (rows.length === 0) {
    return <Card noPadding><EmptyState message="No list scoring yet — the collector populates this after campaigns run." /></Card>;
  }

  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-fg-dim border-b border-bg-border">
              <th className="px-4 py-2.5 font-medium">List</th>
              <th className="px-3 py-2.5 font-medium text-right">Campaigns</th>
              <th className="px-3 py-2.5 font-medium text-right">Sent</th>
              <th className="px-3 py-2.5 font-medium text-right">Reply</th>
              <th className="px-3 py-2.5 font-medium text-right">Conversion</th>
              <th className="px-3 py-2.5 font-medium text-right">Score</th>
              <th className="px-3 py-2.5 font-medium text-right">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = verdictPill(r.verdict);
              return (
                <tr key={r.list_id} className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30">
                  <td className="px-4 py-2.5 font-medium text-fg">{r.list_name || r.list_id}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{num(r.campaigns_count)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{num(r.total_sent)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{pct(r.reply_rate)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-fg">{pct(r.conversion_rate)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{num(r.score)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] ${p.cls}`}>{p.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
