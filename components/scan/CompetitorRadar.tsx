"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ScanEvent } from "@/lib/site-scan/events";

/**
 * The businesses around this one, placed where they are: the scanned business at the centre,
 * each competitor at its real distance (log scale, so 1 km and 40 km both fit) and bearing.
 * Drawn only from `competitor` lines that carry a measured distance and bearing; with none, it
 * draws nothing. The data's own attribution travels with it (`data.source_note`).
 */

type Dot = { id: number; name: string; km: number; bearing: number; note: string | null };

const RINGS_KM = [1, 5, 25];
const MAX_KM = 80;
const R = 100;

function dotsOf(events: ScanEvent[]): Dot[] {
  return events.flatMap((e) => {
    if (e.kind !== "competitor" || !e.data) return [];
    const km = Number(e.data.distance_km);
    const bearing = Number(e.data.bearing_deg);
    if (!Number.isFinite(km) || !Number.isFinite(bearing) || km < 0) return [];
    return [{ id: e.id, name: typeof e.data.name === "string" ? e.data.name : e.text, km, bearing, note: typeof e.data.source_note === "string" ? e.data.source_note : null }];
  });
}

/** Distance to radius: log scale between 0.2 km and MAX_KM. */
export function radiusFor(km: number): number {
  const lo = Math.log(0.2);
  const hi = Math.log(MAX_KM);
  const v = (Math.log(Math.max(0.2, Math.min(MAX_KM, km))) - lo) / (hi - lo);
  return Math.max(10, v * R);
}

export function CompetitorRadar({ events }: { events: ScanEvent[] }) {
  const reduce = useReducedMotion();
  const dots = dotsOf(events);
  if (!dots.length) return null;
  const notes = [...new Set(dots.map((d) => d.note).filter((n): n is string => !!n))];
  return (
    <figure className="border border-ops-edge bg-ops-panel p-4">
      <p className="font-data text-[10px] uppercase tracking-[0.24em] text-signal">Around you</p>
      <svg viewBox="-110 -110 220 220" className="mx-auto mt-3 w-full max-w-[260px]" role="img" aria-label={`${dots.length} businesses doing the same work nearby`}>
        {RINGS_KM.map((km) => (
          <g key={km}>
            <circle r={radiusFor(km)} fill="none" stroke="currentColor" className="text-ops-line" strokeWidth="0.8" />
            <text x="2" y={-radiusFor(km) - 2} className="fill-current text-fg-dim" fontSize="6.5">
              {km} km
            </text>
          </g>
        ))}
        <circle r="3.5" className="fill-signal" />
        {dots.map((d, i) => {
          const rad = ((d.bearing - 90) * Math.PI) / 180;
          const r = radiusFor(d.km);
          return (
            <motion.g key={d.id} initial={reduce ? false : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: reduce ? 0 : i * 0.05, duration: 0.35 }}>
              <circle cx={Math.cos(rad) * r} cy={Math.sin(rad) * r} r="3" className="fill-status-warm">
                <title>{`${d.name}, ${d.km.toFixed(1)} km`}</title>
              </circle>
            </motion.g>
          );
        })}
      </svg>
      <ol className="mt-3 space-y-1 font-data text-[11px]">
        {dots
          .slice()
          .sort((a, b) => a.km - b.km)
          .slice(0, 6)
          .map((d) => (
            <li key={d.id} className="flex justify-between gap-3 text-fg-muted">
              <span className="truncate text-fg">{d.name}</span>
              <span className="shrink-0 tabular-nums">{d.km < 10 ? d.km.toFixed(1) : Math.round(d.km)} km</span>
            </li>
          ))}
      </ol>
      {notes.length ? <figcaption className="mt-3 text-[10px] leading-snug text-fg-dim">{notes.join(" · ")}</figcaption> : null}
    </figure>
  );
}
