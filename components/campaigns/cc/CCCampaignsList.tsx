"use client";

/**
 * CCCampaignsList — the Campaigns manager table. Lists every Constant Contact
 * campaign (draft / scheduled / sent) with status + open/click rates, filterable,
 * row-click opens the detail drawer. Data: /api/campaigns/constant-contact/campaigns.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, EmptyState, Tag } from "@/components/Card";
import type { CampaignRef } from "../ConstantContactConsole";

type Row = {
  campaign_id: string;
  name: string;
  status: string;
  type: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_sent_date: string | null;
  counts: Record<string, number>;
  open_rate: number | null;
  click_rate: number | null;
};

type Bucket = "all" | "draft" | "scheduled" | "sent";

function bucketOf(status: string): Exclude<Bucket, "all"> | "other" {
  const s = (status || "").toUpperCase();
  if (s === "DRAFT") return "draft";
  if (s === "SCHEDULED") return "scheduled";
  if (["DONE", "EXECUTING", "SENT", "COMPLETED"].includes(s)) return "sent";
  return "other";
}

function statusTone(status: string): "neutral" | "info" | "engaged" | "hot" | "warm" {
  switch (bucketOf(status)) {
    case "draft": return "neutral";
    case "scheduled": return "info";
    case "sent": return "engaged";
    default: return (status || "").toUpperCase() === "ERROR" ? "hot" : "warm";
  }
}

const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function CCCampaignsList({ onSelect }: { onSelect: (c: CampaignRef) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Bucket>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/campaigns", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.message || data?.error || "Couldn't load campaigns.");
        return;
      }
      setRows((data.campaigns || []) as Row[]);
    } catch {
      setError("Network error loading campaigns.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => bucketOf(r.status) === filter)),
    [rows, filter],
  );

  const counts = useMemo(() => {
    const c = { all: rows.length, draft: 0, scheduled: 0, sent: 0 };
    for (const r of rows) {
      const b = bucketOf(r.status);
      if (b === "draft" || b === "scheduled" || b === "sent") c[b]++;
    }
    return c;
  }, [rows]);

  const chips: { key: Bucket; label: string }[] = [
    { key: "all", label: `All (${counts.all})` },
    { key: "draft", label: `Draft (${counts.draft})` },
    { key: "scheduled", label: `Scheduled (${counts.scheduled})` },
    { key: "sent", label: `Sent (${counts.sent})` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${filter === c.key ? "border-accent/40 bg-accent/10 text-accent" : "border-bg-border text-fg-muted hover:text-fg"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void load()} className="text-[11px] text-fg-dim underline hover:text-fg-muted">Refresh</button>
      </div>

      {loading ? (
        <Card noPadding><div className="p-6 text-sm text-fg-dim italic">Loading campaigns…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : filtered.length === 0 ? (
        <Card noPadding><EmptyState message="No campaigns in this view yet. Compose one to get started." /></Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Campaign</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Sent / Updated</th>
                  <th className="px-4 py-2.5 font-medium text-right">Open</th>
                  <th className="px-4 py-2.5 font-medium text-right">Click</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.campaign_id}
                    onClick={() => onSelect({ campaign_id: r.campaign_id, name: r.name, status: r.status })}
                    className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30 cursor-pointer"
                  >
                    <td className="px-4 py-2.5 text-fg max-w-[320px] truncate">{r.name || "(untitled)"}</td>
                    <td className="px-4 py-2.5"><Tag tone={statusTone(r.status)}>{(r.status || "").toLowerCase()}</Tag></td>
                    <td className="px-4 py-2.5 text-fg-muted">{fmtDate(r.last_sent_date || r.updated_at)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{pct(r.open_rate)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{pct(r.click_rate)}</td>
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
