/**
 * lib/lead-staleness.ts — canonical "when was this lead last touched?" reader.
 *
 * Single source of truth for the SLA / cold-badge / sort-by-touch /
 * Touch-First-pick paths across the dashboard. Without this helper every
 * caller invents its own fallback ladder; the bug pattern that bit OASIS
 * was a `last_touch_at || updated_at` ladder where `updated_at` gets
 * bumped on any unrelated row write (ai_score sync, stage edit, manual
 * enrichment) — so a never-contacted lead suddenly looks freshly touched.
 *
 * Fallback ladder (highest-trust to lowest-trust):
 *   1. data.last_contacted_at  — populated by the migration 074 trigger
 *      whenever lead_interactions gets a new row.
 *   2. data.last_touch_at      — legacy field, written by some Python
 *      daemons before send_gateway / lead_interactions was unified.
 *   3. data.submitted_at /
 *      data.date_submitted     — SunBiz lead-form intake stamp (set by
 *      /api/forms/submit when a published form posts a new lead). Real
 *      touch signal — initial application receipt resets the SLA clock.
 *   4. row.created_at          — when this lead/application entered the
 *      system. For a never-contacted lead, the SLA clock SHOULD start
 *      here; we want a 30-day-old uncontacted lead to surface as overdue.
 *
 * `row.updated_at` is deliberately NOT in the ladder. It's noisy — bumped
 * by every UPDATE statement on the row — and using it as a staleness
 * proxy is the bug class this helper exists to fix.
 */

type Bag = Record<string, unknown> | null | undefined;

type RowLike = {
  data?: Bag;
  created_at?: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Returns the canonical "last touched" ISO timestamp for a lead-shaped
 * row. Pass either a TenantRecord-style row ({ data, created_at }) or
 * the raw data bag (the helper handles both shapes).
 */
export function lastTouchIso(row: RowLike): string | null {
  const d: Bag = row.data ?? null;
  const get = (k: string): string | null =>
    d && typeof d === "object" ? str((d as Record<string, unknown>)[k]) : null;
  return (
    get("last_contacted_at") ||
    get("last_touch_at") ||
    get("submitted_at") ||
    get("date_submitted") ||
    row.created_at ||
    null
  );
}

/**
 * Variant for callers that have already flattened the record (e.g.
 * the leads-table client which exposes `last_contacted_at` directly
 * on the row, not nested under `data`). Same ladder, flat shape.
 */
export function lastTouchIsoFlat(row: {
  last_contacted_at?: string | null;
  last_touch_at?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
}): string | null {
  return (
    str(row.last_contacted_at) ||
    str(row.last_touch_at) ||
    str(row.submitted_at) ||
    row.created_at ||
    null
  );
}
