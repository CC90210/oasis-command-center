import type { SiteStatus } from "@/lib/seo/types";
import { MISSING, STATUS_LABEL, type Change } from "@/lib/seo/format";

/** An unknown value. Screen readers hear "no data", never a dash. */
export function Missing({ label = "no data" }: { label?: string }) {
  return (
    <span className="text-fg-dim">
      <span aria-hidden>{MISSING}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A change with its sign; colour is never the only signal. */
export function ChangeCell({ change, none = "no prior data" }: { change: Change | null; none?: string }) {
  if (!change) return <Missing label={none} />;
  const tone = change.tone === "good" ? "text-status-engaged" : change.tone === "bad" ? "text-status-hot" : "text-fg-muted";
  return (
    <span className={`tabular-nums ${tone}`}>
      <span aria-hidden>{change.text}</span>
      <span className="sr-only">{change.sr}</span>
    </span>
  );
}

const STATUS_STYLE: Record<SiteStatus, { glyph: string; tone: string }> = {
  current: { glyph: "●", tone: "text-status-engaged" },
  collecting: { glyph: "◐", tone: "text-status-info" },
  waiting: { glyph: "○", tone: "text-fg-muted" },
  behind: { glyph: "▲", tone: "text-status-warm" },
  access_removed: { glyph: "■", tone: "text-status-hot" },
};

/** Glyph carries the colour, the word carries the meaning. */
export function StatusBadge({ status }: { status: SiteStatus }) {
  const s = STATUS_STYLE[status] ?? { glyph: "?", tone: "text-fg-muted" };
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-fg">
      <span aria-hidden className={s.tone}>{s.glyph}</span>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function UnavailableBanner() {
  return (
    <div role="alert" className="mt-6 rounded-lg border border-status-warm/40 bg-bg-panel px-4 py-3 text-sm">
      <strong className="font-semibold text-fg">SEO data unavailable.</strong>{" "}
      <span className="text-fg-muted">
        The measurement service did not answer, so nothing here is a zero: it is unknown. The health monitor pages if this lasts.
      </span>
    </div>
  );
}
