"use client";

import { useEffect, useId, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "@/lib/seo/types";
import { fmtCtr, fmtDate, fmtInt, fmtMonth, fmtPos } from "@/lib/seo/format";

type Metric = "clicks" | "impressions" | "ctr" | "position";
const METRICS: { key: Metric; label: string }[] = [
  { key: "clicks", label: "Clicks" },
  { key: "impressions", label: "Impressions" },
  { key: "ctr", label: "CTR" },
  { key: "position", label: "Avg position" },
];
const fmtValue = (m: Metric, v: number) => (m === "ctr" ? fmtCtr(v) : m === "position" ? fmtPos(v) : fmtInt(v)) ?? "";

// Token colours read at runtime: SVG attributes cannot be trusted with var(), and raw hex
// would break the token rule. Before mount everything is currentColor.
const TOKENS = { line: "--c-accent", grid: "--c-bg-border", axis: "--c-fg-dim", panel: "--c-bg-elev", edge: "--c-bg-border-strong", text: "--c-fg" } as const;
type Colors = Record<keyof typeof TOKENS, string>;
const FALLBACK: Colors = { line: "currentColor", grid: "currentColor", axis: "currentColor", panel: "transparent", edge: "currentColor", text: "currentColor" };

function useTokenColors(): Colors {
  const [c, setC] = useState<Colors>(FALLBACK);
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (v: string) => { const raw = css.getPropertyValue(v).trim(); return raw ? `rgb(${raw})` : "currentColor"; };
    setC(Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, read(v)])) as Colors);
  }, []);
  return c;
}

export function TrendChart({ points, grain }: { points: TrendPoint[]; grain: "day" | "month" }) {
  const [metric, setMetric] = useState<Metric>("clicks");
  const group = useId();
  const c = useTokenColors();
  const at = (v: string) => (grain === "month" ? fmtMonth(v) : fmtDate(v)) ?? v;
  const label = METRICS.find((m) => m.key === metric)?.label ?? metric;
  if (points.length === 0) return <p className="text-sm text-fg-dim">No data in this range yet.</p>;
  return (
    <figure className="rounded-lg border border-hairline bg-bg-panel p-4">
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">Metric to plot</legend>
        {METRICS.map((m) => (
          <label key={m.key} className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${metric === m.key ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}>
            <input type="radio" name={group} value={m.key} checked={metric === m.key} onChange={() => setMetric(m.key)} className="sr-only" />
            {m.label}
          </label>
        ))}
      </fieldset>
      <div className="mt-3 h-56 text-fg-dim" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={c.grid} strokeOpacity={0.6} />
            <XAxis dataKey="at" tickFormatter={at} tick={{ fill: c.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: c.grid }} minTickGap={32} />
            <YAxis
              reversed={metric === "position"}
              domain={metric === "position" ? ["dataMin", "dataMax"] : [0, "auto"]}
              allowDecimals={metric === "ctr" || metric === "position"}
              tickFormatter={(v: number) => fmtValue(metric, v)}
              tick={{ fill: c.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={56}
            />
            <Tooltip
              formatter={(v) => [fmtValue(metric, Number(v)), label]}
              labelFormatter={(v) => at(String(v))}
              contentStyle={{ background: c.panel, border: `1px solid ${c.edge}`, borderRadius: 6, fontSize: 12, color: c.text }}
              cursor={{ stroke: c.edge }}
            />
            <Line type="monotone" dataKey={metric} stroke={c.line} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 text-xs text-fg-dim">
        {label} by {grain === "month" ? "month" : "day"}.{metric === "position" && " Lower is better: position 1 is the top result, so the axis is flipped."}
      </figcaption>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">Show as table</summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-fg-muted">
                <th scope="col" className="px-2 py-1 text-left font-medium">{grain === "month" ? "Month" : "Day"}</th>
                {METRICS.map((m) => <th key={m.key} scope="col" className="px-2 py-1 text-right font-medium">{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.at} className="border-t border-hairline">
                  <th scope="row" className="px-2 py-1 text-left font-normal text-fg">{at(p.at)}</th>
                  {METRICS.map((m) => <td key={m.key} className="px-2 py-1 text-right tabular-nums text-fg">{fmtValue(m.key, p[m.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
