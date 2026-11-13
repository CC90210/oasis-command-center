"use client";

import { useState } from "react";
import type { ScanDay } from "@/lib/site-scan/metrics";

/**
 * Free scans per day, last 30 days: one series, one hue (the workspace accent), bars anchored to
 * the baseline with a 2px gap, rounded data ends, a hover readout per day (scans and how many
 * were sent to the team). The table below the chart on the page carries the same numbers.
 */
export function ScanTrend({ days }: { days: ScanDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.scans));
  const total = days.reduce((s, d) => s + d.scans, 0);
  const h = hover !== null ? days[hover] : null;
  const label = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <figure className="rounded-xl border border-hairline bg-bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption className="text-sm font-semibold text-fg">Scans per day, last 30 days</figcaption>
        <p className="text-[12px] tabular-nums text-fg-muted" aria-live="polite">
          {h ? `${label(h.day)}: ${h.scans} scan${h.scans === 1 ? "" : "s"}, ${h.claimed} sent to the team` : `${total} in 30 days`}
        </p>
      </div>
      <div className="mt-4 flex h-28 items-end gap-[2px] border-b border-hairline" role="img" aria-label={`Scans per day for the last 30 days, ${total} in total`} onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <button
            key={d.day}
            type="button"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${label(d.day)}: ${d.scans} scans, ${d.claimed} sent to the team`}
            className="group flex h-full min-w-0 flex-1 items-end focus:outline-none"
          >
            <span
              className={`block w-full rounded-t-[4px] ${d.scans ? (hover === i ? "bg-accent" : "bg-accent/70 group-focus-visible:bg-accent") : "bg-transparent"}`}
              style={{ height: d.scans ? `${Math.max(4, (d.scans / max) * 100)}%` : 0 }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-fg-dim">
        <span>{days[0] ? label(days[0].day) : ""}</span>
        <span>max {max} a day</span>
        <span>{days.length ? label(days[days.length - 1].day) : ""}</span>
      </div>
    </figure>
  );
}
