"use client";

/**
 * Cumulative revenue collected across the goal period against the straight-line
 * pace to the target (2026-09-24). Replaces the MRR trajectory on Today, which
 * plotted a hand-typed profile number (or a synthetic curve when none existed).
 * Days after today are pace-only: the actual line stops where the data stops.
 */

import {
  Area,
  AreaChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type GoalPacePoint = { date: string; collected: number | null; pace: number };

export function GoalPaceChart({ data, target }: { data: GoalPacePoint[]; target: number }) {
  const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="goalCollected" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tick={{ fill: "#5b6068", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#22262e" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "#5b6068", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`)}
            domain={[0, Math.max(target, ...data.map((d) => d.collected ?? 0)) * 1.1]}
          />
          <Tooltip
            contentStyle={{ background: "#0e1014", border: "1px solid #22262e", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#9ca0a8" }}
            formatter={(v: number, name: string) => [money(v), name === "pace" ? "Pace to target" : "Collected (USD)"]}
          />
          <ReferenceLine
            y={target}
            stroke="#10b981"
            strokeDasharray="3 3"
            label={{ value: money(target), fill: "#10b981", fontSize: 11, position: "right" }}
          />
          <Line type="linear" dataKey="pace" stroke="#5b6068" strokeDasharray="4 4" dot={false} strokeWidth={1.5} />
          <Area
            type="stepAfter"
            dataKey="collected"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#goalCollected)"
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
