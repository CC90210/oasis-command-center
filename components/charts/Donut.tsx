/**
 * Donut — a progress ring (rate gauge). Generalized from GoalCountdownCard. The arc is
 * `currentColor` set by a text-* class chosen from `tone` or a value threshold; the track
 * is a hairline neutral. Centered tabular-nums label. Semantic color only ever encodes a
 * real threshold (deliverability, engagement), never decoration.
 */
function toneClass(pct: number, tone?: "accent" | "engaged" | "warm" | "hot" | "threshold"): string {
  if (tone && tone !== "threshold") return { accent: "text-accent", engaged: "text-status-engaged", warm: "text-status-warm", hot: "text-status-hot" }[tone];
  // threshold: high = good, low = bad
  if (pct >= 60) return "text-status-engaged";
  if (pct >= 30) return "text-accent";
  if (pct >= 10) return "text-status-warm";
  return "text-status-hot";
}

export function Donut({
  pct,
  size = 68,
  stroke = 6,
  label,
  sublabel,
  tone = "threshold",
}: {
  pct: number;
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
  tone?: "accent" | "engaged" | "warm" | "hot" | "threshold";
}) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (clamped / 100) * circ;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className={toneClass(clamped, tone)}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#22262e" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray .5s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-[13px] font-semibold text-fg tabular-nums">{label ?? `${clamped.toFixed(0)}%`}</span>
        {sublabel && <span className="text-[9px] uppercase tracking-wide text-fg-dim mt-0.5">{sublabel}</span>}
      </div>
    </div>
  );
}
