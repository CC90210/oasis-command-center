/**
 * lib/format-helpers.ts — small client-safe formatters shared across
 * the dashboard. No imports beyond plain JS so this loads in both
 * server components and client islands without RSC boundary issues.
 *
 * Existing money/date helpers in lib/pipeline-display.ts are
 * column-aware (they take a `key` arg to decide how to render) and
 * meant for the pipeline table. These are the unkeyed primitives the
 * drawer + timeline panel consume.
 */

/**
 * USD money formatter. Accepts string or number; returns "—" for
 * unparseable input (keeps drawer rows clean instead of "NaN").
 */
export function formatMoney(v: unknown): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (Number.isFinite(n)) {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  }
  return String(v);
}

/**
 * Relative-time formatter — "5m ago", "2h ago", "3d ago", or
 * the absolute date once beyond 30 days. Used by every timeline-
 * adjacent surface (LeadTimelinePanel, LeadDetailDrawer header,
 * IntegrationKeysPanel last-tested label).
 */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
