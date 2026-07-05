/**
 * Funnel — descending stepped bars (delivered → opened → clicked → converted) sharing a
 * left baseline, with the retention % called out between steps. One accent hue at
 * descending opacity, not a rainbow. Reads as "where recipients drop off".
 */
const OPACITY = [1, 0.68, 0.44, 0.28];

export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const top = steps[0]?.value || 0;
  return (
    <div className="space-y-1">
      {steps.map((s, i) => {
        const pct = top ? (s.value / top) * 100 : 0;
        const prev = i > 0 ? steps[i - 1].value : s.value;
        const retention = prev ? (s.value / prev) * 100 : 100;
        return (
          <div key={s.label}>
            {i > 0 && (
              <div className="pl-1 text-[10px] text-fg-dim tabular-nums">↓ {retention.toFixed(0)}% retained</div>
            )}
            <div className="flex items-center gap-3">
              <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-bg-elev">
                <div className="h-full bg-accent" style={{ width: `${Math.max(pct, 2)}%`, opacity: OPACITY[i] ?? 0.28 }} />
              </div>
              <div className="flex w-32 items-baseline justify-between text-[11px]">
                <span className="text-fg-dim">{s.label}</span>
                <span className="tabular-nums text-fg">{s.value.toLocaleString()}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
