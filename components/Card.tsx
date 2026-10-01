import type { ReactNode } from "react";
import { PageFrame } from "@/components/os/PageFrame";

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

/**
 * The pre-OS page header, kept for its callers: it IS the OS PageFrame header
 * now (W1a, U1-01), so every page still on it gets the OS type scale and the
 * OS actions row in one change (title 20/28, subtitle 13/20, actions beside the
 * title from `lg` and stacked under it below that, MainShell's breakpoint).
 *
 * PageFrame wraps a page's body and a PageHeader sits above one, so this
 * renders PageFrame with no children. Nothing here adds padding, width or
 * motion: MainShell's canvas owns those, as it does for PageFrame.
 *
 * New pages use PageFrame directly. tests/ui-chrome.test.ts holds the list of
 * files still importing PageHeader to a baseline that only shrinks.
 */
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
    <PageFrame title={title} subtitle={subtitle} actions={action}>
      {null}
    </PageFrame>
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
