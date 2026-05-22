/**
 * Display helpers for the cross-agent event bus feed.
 *
 * Event types are stored in the database in SCREAMING_SNAKE_CASE
 * (e.g. `BRAVO_EMAIL_OPENED`, `BRAVO_LEAD_AUTO_BUMPED`) — that's the
 * wire format producers and consumers agree on. They look terrible
 * in the UI. These helpers turn them into "Email opened", "Lead
 * auto bumped" without losing the underlying string anywhere.
 *
 * Same treatment for publisher slugs like `oasis_lead_stage_engine` →
 * "Oasis lead stage engine".
 *
 * Why a separate file: both the /agents page and any future event-feed
 * surfaces (the dashboard tile, the audit log) should agree on the
 * formatting. Centralizing here means a single place to add per-type
 * overrides later (e.g., "BRAVO_EMAIL_OPENED" → "Email opened" with
 * a custom icon).
 */

/**
 * Strip the leading agent prefix from an event type and convert the
 * remaining SCREAMING_SNAKE_CASE to sentence case.
 *
 * Examples:
 *   "BRAVO_EMAIL_OPENED"          → "Email opened"
 *   "BRAVO_LEAD_AUTO_BUMPED"      → "Lead auto bumped"
 *   "BRAVO_RECORD_STATUS_CHANGED" → "Record status changed"
 *   "OUTBOUND.RECORDED"           → "Outbound recorded"
 *
 * Falls back to the raw string when input shape is unexpected (lowercased
 * already, missing prefix, etc.) so we never blank out a row.
 */
export function formatEventType(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  // Strip the producer agent prefix — BRAVO_, MAVEN_, ATLAS_, AURA_,
  // HERMES_, plus any future agent. Anything followed by underscore
  // at the start of the string and matching an upper-case word.
  let body = raw.replace(/^[A-Z]+_/, "");
  // Some legacy producers use dot-separated event names (e.g.
  // "outbound.recorded"). Treat dots as another word separator so
  // both shapes display the same way.
  body = body.replace(/[._]+/g, " ").trim();
  if (!body) return raw;
  // Lowercase + capitalize the first letter. Subsequent words stay
  // lowercase ("Lead auto bumped" — not "Lead Auto Bumped") because
  // sentence case reads as content, title case reads as a heading
  // and the row already has a tag chrome around it.
  const lowered = body.toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

/**
 * Pretty-print a publisher slug for display. Same rules as
 * formatEventType but inputs are typically `snake_case` rather than
 * SCREAMING_SNAKE_CASE.
 *
 * Examples:
 *   "oasis_lead_stage_engine" → "Oasis lead stage engine"
 *   "manifest-data"           → "Manifest data"
 *   "bravo"                   → "Bravo"
 */
export function formatPublisher(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  const body = raw.replace(/[._-]+/g, " ").trim();
  if (!body) return raw;
  const lowered = body.toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}
