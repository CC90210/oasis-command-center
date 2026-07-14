"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import type { TrendPoint } from "@/lib/metrics/types";

/**
 * Daily send/open/click trend, themed to the dark palette (accent #3b82f6 area
 * fading to transparent, status-info clicks line, faint bg-border gridlines,
 * fg-dim axes, bg-panel tooltip). Recharts is SVG → SSRs cleanly in one client
 * island. Empty/short series renders a quiet placeholder instead of a broken axis.
 */
export function TrendArea({ data, height = 200 }: { data: TrendPoint[]; height?: number }) {
  const hasData = data.some((d) => d.sent + d.opens + d.clicks > 0);
  if (!hasData) {
    return (
      <div className="flex items-center justify-center text-sm text-fg-dim" style={{ height }}>
        No activity in this window yet.
      </div>
    );
  }
  const fmtDate = (d: string) => {
    const [, m, day] = d.split("-");
    return `${Number(m)}/${Number(day)}`;
  };
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="mtxOpens" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="mtxSent" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5b6068" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#5b6068" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#22262e" strokeOpacity={0.6} />
          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: "#5b6068", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#22262e" }} minTickGap={24} />
          <YAxis tick={{ fill: "#5b6068", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip
            contentStyle={{ background: "#0e1014", border: "1px solid #22262e", borderRadius: 10, fontSize: 12, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}
            labelStyle={{ color: "#9ca0a8", marginBottom: 4 }}
            labelFormatter={(d: string) => fmtDate(d)}
            itemStyle={{ padding: 0 }}
          />
          <Area type="monotone" dataKey="sent" name="Sent" stroke="#5b6068" strokeWidth={1.5} fill="url(#mtxSent)" />
          <Area type="monotone" dataKey="opens" name="Opens" stroke="#3b82f6" strokeWidth={2} fill="url(#mtxOpens)" />
          <Area type="monotone" dataKey="clicks" name="Clicks" stroke="#60a5fa" strokeWidth={1.5} fillOpacity={0} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
