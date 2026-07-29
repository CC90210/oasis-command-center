/**
 * classify-reply-schema.ts — the PURE half of lender-reply classification:
 * types, the category/reason allowlists, quoted-text stripping, and the
 * schema validator that stands between untrusted model output and a write.
 *
 * Deliberately free of `server-only`, network, and Supabase imports so the
 * security boundary can be unit-tested for real (tests/lender-reply-classify
 * .test.ts) rather than only type-checked. The server half lives in
 * ./classify-reply.ts.
 *
 * SECURITY: a lender email body is UNTRUSTED. It is fenced as data in the
 * prompt, and whatever comes back is validated here — allowlisted category and
 * reason code, sane numeric ranges, bounded strings — before the scan route
 * acts on it. Anything unrecognised fails CLOSED to "unknown", which the route
 * refuses to write.
 */

export type LenderReplyCategory =
  | "approved"
  | "counter_offer"
  | "declined"
  | "info_needed"
  | "submitted"
  | "unknown";

/** Structured decline taxonomy — the queryable "why" behind a pass. */
export type LenderDeclineReasonCode =
  | "too_many_positions"
  | "insufficient_revenue"
  | "low_avg_daily_balance"
  | "high_nsf_negative_days"
  | "industry_restricted"
  | "state_restricted"
  | "time_in_business_short"
  | "low_fico"
  | "recent_default_unsatisfied"
  | "stacking_concern"
  | "paper_grade_mismatch"
  | "amount_too_high"
  | "incomplete_file"
  | "other";

export type LenderReplyClass = {
  category: LenderReplyCategory;
  amount: number | null;
  term_months: number | null;
  factor_rate: number | null;
  /** 0-1 model confidence in the category. */
  confidence: number;
  /** Structured decline reason (declined / counter_offer only), else null. */
  decline_reason_code: LenderDeclineReasonCode | null;
  /** The lender's verbatim reason text (bounded), else null. */
  decline_reason_detail: string | null;
  /** Counter-offer conditions (payoff / consolidation / stipulations), else []. */
  conditions: string[];
  /**
   * TRUE only when the classifier itself could not run (inference unavailable).
   * Both this and an unparseable reply yield category "unknown" so the write
   * gate stays fail-closed, but the caller MUST be able to tell them apart:
   * from 2026-07-21 the classifier was dead and every reply came back
   * "unknown", which was indistinguishable from 40 lenders being chatty. That
   * ambiguity is what let a total outage run silently for a week.
   */
  unavailable: boolean;
};

const CATS: LenderReplyCategory[] = [
  "approved", "counter_offer", "declined", "info_needed", "submitted", "unknown",
];
const DECLINE_CODES: LenderDeclineReasonCode[] = [
  "too_many_positions", "insufficient_revenue", "low_avg_daily_balance", "high_nsf_negative_days",
  "industry_restricted", "state_restricted", "time_in_business_short", "low_fico",
  "recent_default_unsatisfied", "stacking_concern", "paper_grade_mismatch", "amount_too_high",
  "incomplete_file", "other",
];

/** Fresh object each call — never hand callers a shared mutable singleton. */
function baseFallback(unavailable: boolean): LenderReplyClass {
  return {
    category: "unknown", amount: null, term_months: null, factor_rate: null,
    confidence: 0, decline_reason_code: null, decline_reason_detail: null,
    conditions: [], unavailable,
  };
}

/** The reply could not be parsed. Fail closed; the reply itself is the reason. */
export const FALLBACK: LenderReplyClass = baseFallback(false);

/** The classifier could not RUN. Fail closed, but flag it as an outage. */
export const CLASSIFIER_UNAVAILABLE: LenderReplyClass = baseFallback(true);

/**
 * Isolate the lender's NEW message — strip the quoted original (our "New Deal"
 * submission) + forwarded headers that otherwise dilute/confuse classification.
 */
export function topOfReply(body: string): string {
  const raw = String(body || "");
  const markers = [
    /\r?\nOn .+ wrote:/i,
    /\r?\n-{2,}\s*Original Message\s*-{2,}/i,
    /\r?\n_{5,}/,
    /\r?\nFrom:\s.+\r?\n\s*(Sent|Date|To):/i,
    /\r?\n>.*/,
  ];
  let cut = raw.length;
  for (const m of markers) {
    const idx = raw.search(m);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  const top = raw.slice(0, cut).trim();
  return top.length >= 8 ? top : raw.slice(0, 1500);
}

/**
 * Validate + clamp raw model output into a LenderReplyClass. Never throws.
 *
 * Out-of-range numerics are dropped to null rather than clamped to a boundary:
 * a boundary value would read downstream as a real quoted term and could land
 * in the Offers tab as a fabricated number.
 */
export function parseClassification(text: string): LenderReplyClass {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return baseFallback(false);

  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(m[0]) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return baseFallback(false);
    parsed = p as Record<string, unknown>;
  } catch {
    return baseFallback(false);
  }

  const category = CATS.includes(parsed.category as LenderReplyCategory)
    ? (parsed.category as LenderReplyCategory)
    : "unknown";

  const posNum = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

  let amount = posNum(parsed.amount);
  if (amount !== null && (amount < 1000 || amount > 5_000_000)) amount = null;
  let term_months = posNum(parsed.term_months);
  if (term_months !== null && (term_months < 1 || term_months > 60)) term_months = null;
  let factor_rate = posNum(parsed.factor_rate);
  if (factor_rate !== null && (factor_rate < 1.0 || factor_rate > 2.0)) factor_rate = null;

  const confidence =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;

  let decline_reason_code: LenderDeclineReasonCode | null =
    DECLINE_CODES.includes(parsed.decline_reason_code as LenderDeclineReasonCode)
      ? (parsed.decline_reason_code as LenderDeclineReasonCode)
      : null;
  // A decline reason is only meaningful on a decline or a counter.
  if (category !== "declined" && category !== "counter_offer") decline_reason_code = null;

  const decline_reason_detail =
    typeof parsed.decline_reason_detail === "string" && parsed.decline_reason_detail.trim()
      ? parsed.decline_reason_detail.trim().slice(0, 500)
      : null;

  const conditions = Array.isArray(parsed.conditions)
    ? parsed.conditions
        .filter((c): c is string => typeof c === "string" && !!c.trim())
        .map((c) => c.trim().slice(0, 200))
        .slice(0, 8)
    : [];

  return {
    category, amount, term_months, factor_rate, confidence,
    decline_reason_code, decline_reason_detail, conditions,
    unavailable: false,
  };
}
