"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Six months of money in vs out (CAD equivalents), transfers excluded. */
export function InOutChart({ data }: { data: Array<{ month: string; inCents: number; outCents: number }> }) {
  const rows = data.map((d) => ({ month: d.month, In: d.inCents / 100, Out: d.outCents / 100 }));
  const fmt = (v: number) => `$${Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`;
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid vertical={false} stroke="#1a1d24" />
          <XAxis dataKey="month" tick={{ fill: "#5b6068", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#22262e" }} />
          <YAxis tick={{ fill: "#5b6068", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmt} width={48} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.03)" }}
            contentStyle={{ background: "#0e1014", border: "1px solid #22262e", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#9ca0a8" }}
            formatter={(v: number, name: string) => [`CA$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, name]}
          />
          <Bar dataKey="In" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Bar dataKey="Out" fill="#9ca0a8" radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
