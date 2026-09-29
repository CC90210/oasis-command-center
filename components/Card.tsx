import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  children,
  action,
  noPadding = false,
  id,
  className,
}: {
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  noPadding?: boolean;
  id?: string;
  className?: string;
}) {
  // Layout classes from the caller append to the Card's own chrome — they
  // don't replace it. Same idiom as the `id` prop added in commit 44474f9.
  const sectionClass = [
    // `card-glow` (a 40px saturated-blue halo on hover) removed: a border
    // separates, a shadow elevates, and a coloured bloom does neither.
    // OASIS OS: a card sits on the same plane as the canvas, so it takes a
    // hairline and no shadow at all (shadows only lift overlays).
    "rounded-xl border border-hairline bg-bg-panel transition-colors duration-150 hover:border-bg-border-strong",
    className || "",
  ].filter(Boolean).join(" ");
  return (
    <section id={id} className={sectionClass}>
      {(title || subtitle || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-4 py-3">
          <div>
            {title && (
              // Section heading: 14px semibold, sentence case. Uppercase with
              // tracking is reserved for chips (Tag below).
              <h2 className="text-sm font-semibold text-fg">
                {title}
              </h2>
            )}
            {subtitle && (
              <div className="text-[13px] leading-5 text-fg-muted mt-0.5">{subtitle}</div>
            )}
          </div>
          {action}
        </header>
      )}
      <div className={noPadding ? "" : "p-4"}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  accent = false,
  delta,
  deltaLabel,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
  delta?: number;
  deltaLabel?: string;
}) {
  const deltaPositive = typeof delta === "number" && delta > 0;
  const deltaNegative = typeof delta === "number" && delta < 0;
  return (
    // `scan-line` (a tinted band sweeping every tile on a 6s infinite loop) and
    // `shadow-ironman` (a 40px blue halo) both removed. A stat tile shows a
    // number; perpetual motion on it competes with the number for attention and
    // costs a compositor layer per tile for the whole session.
    <div className="rounded-xl border border-hairline bg-bg-panel p-4 transition-colors duration-150 hover:border-bg-border-strong group">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-fg-muted">
          {label}
        </div>
        {typeof delta === "number" && (
          <span
            className={`text-[10px] font-bold ${
              deltaPositive
                ? "text-status-engaged"
                : deltaNegative
                  ? "text-status-hot"
                  : "text-fg-dim"
            }`}
          >
            {deltaPositive ? "▲" : deltaNegative ? "▼" : "·"}{" "}
            {Math.abs(delta).toFixed(1)}
            {deltaLabel ? ` ${deltaLabel}` : "%"}
          </span>
        )}
      </div>
      {/* The accent variant is colour alone. Its 8px blue drop-shadow was a
          glow, and a glow is not emphasis. */}
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${
          accent ? "text-accent" : "text-fg"
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-xs text-fg-dim">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  message,
  cta,
}: {
  message: string;
  cta?: ReactNode;
}) {
  return (
    <div className="text-center py-10 text-fg-muted text-sm">
      <div>{message}</div>
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    // STACKS BELOW `lg`, and nothing at `lg` or above changes. The action slot
    // (a segmented control on /web-leads) is ~200px wide, and the content box
    // it shares is 358px on a 390px phone and only 464px at 768 -- MainShell's
    // 240px sidebar margin starts at `md`, so a tablet is NARROWER for content
    // than a phone is. Measured 2026-08-25: the subtitle wrapped into a
    // nine-line sliver at 390 and a four-line one at 768. `lg` is the first
    // width where both fit on one line (720px of content box).
    // `lg:flex-row` restores the current layout exactly at every desktop width,
    // so for the other pages using this header the change is stacking below
    // 1024 and nothing else.
    <header className="mb-6 flex flex-col items-start justify-between gap-3 lg:flex-row lg:gap-4">
      <div className="min-w-0">
        {/* Page title 20/28 semibold (OS type scale). The accent-to-transparent
            gradient rule that trailed every title is gone: gradient decoration
            is one of the generated-UI tells #464 removed elsewhere. */}
        <h1 className="text-xl leading-7 font-semibold tracking-[-0.01em] text-fg">
          {title}
        </h1>
        {subtitle && (
          <div className="text-[13px] leading-5 text-fg-muted mt-1">{subtitle}</div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "hot" | "warm" | "engaged" | "info";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-bg-elev text-fg-muted border-hairline",
    accent: "bg-accent-soft text-accent border-accent/30",
    hot: "bg-status-hot/10 text-status-hot border-status-hot/30",
    warm: "bg-status-warm/10 text-status-warm border-status-warm/30",
    engaged: "bg-status-engaged/10 text-status-engaged border-status-engaged/30",
    info: "bg-status-info/10 text-status-info border-status-info/30",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10.5px] font-semibold uppercase tracking-[0.06em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
