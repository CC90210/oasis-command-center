/**
 * infer-result-text.ts — normalize inference_jobs.result_text across data layers.
 *
 * result_text is a TEXT column that usually CONTAINS a JSON document. What the
 * data layer hands back for it depends on the backend:
 *
 *   - Supabase/PostgREST (pre-2026-08-09): the raw string.
 *   - Turso shim (lib/turso-postgrest.ts, fromSql): any TEXT starting with
 *     '{' or '[' is JSON.parsed — so the same column arrives as an OBJECT.
 *
 * queueInfer assumed the string: `(p.result_text || "").trim()`. On shim
 * output that throws `trim is not a function`, which classify-reply caught as
 * CLASSIFIER_UNAVAILABLE — so from the 8/09 cutover to 8/16 every completed
 * classification (including real approvals) was discarded and re-queued every
 * 30 minutes, while the offers-scanner paged BLOCKED. See
 * tests/infer-result-text.test.ts for the reproduced failure.
 *
 * The contract here: whatever the backend's decode, callers get a string —
 * the original JSON text when the shim parsed it, "" for null/absent. Pure and
 * server-only-free so the regression test can run under plain tsx.
 */

/** Coerce a result_text value from any data layer back to its string form. */
export function coerceInferResultText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  // The shim parsed the stored JSON text — serialize it back. For objects and
  // arrays this reproduces the stored document; for stray scalars it is the
  // least-surprising string form.
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    // Circular or otherwise unserializable — impossible for DB output, but a
    // coercion helper must never be the thing that throws.
    return String(v);
  }
}
