/**
 * Sparkline — a tiny inline trend line. Color comes from `currentColor`, so set a
 * text-* class on the parent (e.g. text-accent). No axes, no deps. Promoted from the
 * inline version in LeadDetailDrawer so campaign rows / drawers / engagement can share it.
 */
export function Sparkline({
  values,
  width = 120,
  height = 30,
  area = false,
  className = "",
}: {
  values: number[];
  width?: number;
  height?: number;
  area?: boolean;
  className?: string;
}) {
  if (!values || values.length < 2) return <svg width={width} height={height} className={className} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - ((v - min) / span) * (height - 3) - 1.5] as const);
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      {area && <polygon points={`0,${height} ${line} ${width},${height}`} fill="currentColor" opacity="0.1" />}
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2" fill="currentColor" />
    </svg>
  );
}
