/** DayDivider — centered pill + hairline, splits MessageList into day groups. */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-3 select-none" aria-hidden="true">
      <div className="h-px flex-1 bg-bg-border/60" />
      <span className="text-[10px] uppercase tracking-wider font-semibold text-fg-dim px-2 py-0.5 rounded-full border border-bg-border/60 bg-bg-elev/40">
        {label}
      </span>
      <div className="h-px flex-1 bg-bg-border/60" />
    </div>
  );
}
