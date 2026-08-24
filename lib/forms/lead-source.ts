/**
 * lead-source.ts — canonical lead ORIGINATION channel (Text vs Dial).
 *
 * WHY A NEW FIELD, NOT `data.source`:
 *   `lead.data.source` is already an occupied channel-of-record enum
 *   ("public_form" | "inbound" | "new_from_document" | "smartlead" | ...)
 *   and it feeds pipelineBreakdown()'s `sources` map + the /analytics
 *   "Lead sources" card. Overloading it with text/dial would silently
 *   corrupt both. Origination lives on its own key: `data.lead_source`.
 *
 * WHERE IT COMES FROM:
 *   The operator shares a per-channel link — /f/<tenant>/<form>?source=text
 *   (or ?source=dial), composable with the existing ?rep=<agent> routing.
 *   The public form page reads the param, hands it to /api/forms/submit in
 *   anonymous_init, and initAnonymousLead() stamps it on the new lead.
 *
 * FAILURE BEHAVIOR (required by spec):
 *   A missing or malformed param NEVER rejects the submission. It resolves
 *   to "unknown" — a real, countable bucket. Attribution is best-effort
 *   telemetry; a merchant's application must not die because a marketing
 *   link lost its query string.
 *
 * FIRST TOUCH WINS:
 *   Origination is immutable once set. Retries, duplicate webhook delivery,
 *   and returning-merchant merges must all converge on the SAME value, so
 *   the write rule is adoptLeadSource() below — never a blind overwrite.
 */

/** Real channels. "unknown" is a resolved bucket, not a channel. */
export const LEAD_SOURCE_CHANNELS = ["text", "dial"] as const;

export type LeadSourceChannel = (typeof LEAD_SOURCE_CHANNELS)[number];
export type LeadSource = LeadSourceChannel | "unknown";

export const LEAD_SOURCE_UNKNOWN = "unknown" as const;

/** Stable render/serialize order. Unknown always last. */
export const LEAD_SOURCE_ORDER: readonly LeadSource[] = ["text", "dial", "unknown"];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  text: "Text",
  dial: "Dial",
  unknown: "Unknown",
};

/** The jsonb key on tenant_records.data. Referenced by the metrics route. */
export const LEAD_SOURCE_KEY = "lead_source";
/** ISO timestamp of first attribution — set once, alongside LEAD_SOURCE_KEY. */
export const LEAD_SOURCE_AT_KEY = "lead_source_at";
/** The query-string parameter operators put on shared links. */
export const LEAD_SOURCE_PARAM = "source";

/**
 * Accepted spellings -> canonical channel. A Map (not an object literal) so a
 * hostile `?source=__proto__` or `?source=constructor` can never resolve to an
 * inherited Object.prototype member. Kept deliberately small: these are the
 * spellings a human might paste, not an open synonym list.
 */
const ALIASES = new Map<string, LeadSourceChannel>([
  ["text", "text"],
  ["texts", "text"],
  ["txt", "text"],
  ["sms", "text"],
  ["dial", "dial"],
  ["dials", "dial"],
  ["call", "dial"],
  ["calls", "dial"],
  ["phone", "dial"],
]);

/** Longest alias is 6 chars; anything past this is not a source, it is an
 *  attack or a mangled link. Bound it before lowercasing a huge query string. */
const MAX_RAW_LENGTH = 32;

/**
 * Normalize an untrusted `?source=` value to a canonical LeadSource.
 * Total function: never throws, never returns undefined. Anything it does not
 * recognize — missing, empty, wrong type, unknown word, oversized — is
 * "unknown".
 */
export function normalizeLeadSource(raw: unknown): LeadSource {
  if (typeof raw !== "string") return LEAD_SOURCE_UNKNOWN;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RAW_LENGTH) return LEAD_SOURCE_UNKNOWN;
  return ALIASES.get(trimmed.toLowerCase()) ?? LEAD_SOURCE_UNKNOWN;
}

/** True only for a REAL channel — "unknown" is deliberately excluded. */
export function isLeadSourceChannel(value: unknown): value is LeadSourceChannel {
  return typeof value === "string" && ALIASES.get(value) === value;
}

/**
 * Read side. Pull the stored origination off a lead's `data` jsonb, tolerating
 * every legacy shape: no key at all (pre-migration leads), null, a stale
 * spelling, or a non-string. Always yields a bucket the dashboard can count.
 */
export function readLeadSource(data: Record<string, unknown> | null | undefined): LeadSource {
  if (!data) return LEAD_SOURCE_UNKNOWN;
  return normalizeLeadSource(data[LEAD_SOURCE_KEY]);
}

/**
 * Write rule for an EXISTING lead — the idempotency boundary.
 *
 * Returns the patch to merge, or null when nothing should change. A lead that
 * already carries a real channel is never rewritten, so a retry, a duplicate
 * delivery, or a merchant re-opening a different channel's link cannot flip
 * attribution after the fact. A lead sitting on "unknown" (or on nothing at
 * all) CAN be upgraded once a real channel finally arrives — that is a
 * correction, not a reassignment.
 */
export function adoptLeadSource(
  existing: Record<string, unknown> | null | undefined,
  incomingRaw: unknown,
  nowIso: string,
): Record<string, string> | null {
  const incoming = normalizeLeadSource(incomingRaw);
  if (incoming === LEAD_SOURCE_UNKNOWN) return null; // never downgrade
  if (isLeadSourceChannel(existing?.[LEAD_SOURCE_KEY])) return null; // first touch wins
  return { [LEAD_SOURCE_KEY]: incoming, [LEAD_SOURCE_AT_KEY]: nowIso };
}

/**
 * Build a shareable link carrying the channel tag. Composes with any params the
 * caller already put on the URL (notably ?rep=). Uses URL/URLSearchParams so the
 * value is encoded once and correctly, never string-concatenated.
 */
export function withLeadSourceParam(baseUrl: string, source: LeadSourceChannel): string {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set(LEAD_SOURCE_PARAM, source);
    return u.toString();
  } catch {
    // Relative or malformed base (e.g. SSR with no origin yet) — fall back to a
    // manual append rather than dropping the tag entirely.
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}${LEAD_SOURCE_PARAM}=${encodeURIComponent(source)}`;
  }
}
