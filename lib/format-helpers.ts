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
 * Narrow an unknown to a non-empty trimmed string, or null. Used
 * across the drawer + pipeline view for jsonb-field display where
 * "" should be treated as missing.
 */
export function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Two-letter initials for an avatar/chip. "Velocity Logistics LLC"
 * → "VL"; "Carlos" → "C". Strips whitespace and empties.
 */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}
