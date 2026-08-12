/**
 * lib/lenders/auto-route.ts — when a lender's reply may move the DEAL by itself.
 *
 * Adon, 2026-08-12, choosing how far the reply reader may go without a person:
 * **move the clear ones, flag the rest.**
 *
 * ONE LENDER IS NOT THE DEAL, and that asymmetry is the whole design. A deal is
 * shopped to several funders at once, so the two answers do not carry the same
 * weight:
 *
 *   an APPROVAL is a fact about the DEAL      -> the first clean one moves it
 *   a DECLINE is a fact about that FUNDER     -> takes unanimity, and silence
 *                                                from anyone still out is not
 *                                                a decline
 *
 * Reading a single decline as "the deal is dead" would kill live files every
 * time the first funder passed, which is the ordinary case in this business.
 *
 * EVERYTHING ELSE IS FLAGGED, NOT ROUTED. A counter-offer is a negotiation, an
 * info request is a task, an unknown is an unknown, and a low-confidence read is
 * a guess. None of those are decisions a classifier gets to make about someone's
 * funding, so they surface for a human instead.
 *
 * WHY THIS IS PURE, no I/O and no "server-only": it decides what happens to a
 * real merchant's live deal, and since 2026-08-12 the application's status also
 * decides whether that merchant keeps receiving drip email. A rule with that
 * reach has to be assertable without a database. Same convention as
 * `planDripCancellations` (lib/portals/stage-hooks.ts) and `dealGateFor`
 * (lib/drips/deal-state.ts).
 */

/** The categories the classifier can return. Mirrors LenderReplyCategory in
 *  lib/lenders/classify-reply-schema.ts; restated as the narrow set this rule
 *  actually branches on so a new category cannot silently acquire a routing
 *  meaning it was never designed for. */
export type RoutableCategory = "approved" | "declined" | string;

export type ThreadLike = {
  /** application_lender_threads.status */
  status: string;
};

export type RouteDecision =
  | { move: false; reason: string }
  | { move: true; to: "approved" | "declined"; reason: string };

/**
 * Thread statuses that mean "this funder has not answered yet".
 *
 * `error` is deliberately INCLUDED as outstanding. A send that failed is a
 * funder who was never actually asked, and treating it as a silent decline
 * would let a delivery bug read as a unanimous rejection — the same
 * failure-becomes-a-plausible-answer shape that has bitten this estate before.
 */
const OUTSTANDING = new Set(["sent", "no_response", "queued", "pending", "error"]);

/** Statuses that mean this funder said no. */
const DECLINED = new Set(["declined"]);

export const DEFAULT_MIN_CONFIDENCE = 0.8;

export function minConfidenceFromEnv(): number {
  const raw = (process.env.LENDER_AUTOROUTE_MIN_CONFIDENCE || "").trim();
  const n = raw ? Number(raw) : NaN;
  // A missing, unparseable or out-of-range value must not read as 0, which
  // would auto-route every guess the classifier makes.
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_MIN_CONFIDENCE;
  return n;
}

/** Master switch. Everything ships inert; a deal only moves once this is on. */
export function autoRouteLive(): boolean {
  return (process.env.LENDER_AUTOROUTE_LIVE || "").trim() === "1";
}

/**
 * Should this reply move the application, and where?
 *
 * `threads` must be EVERY thread on the application, including the one this
 * reply belongs to and including any that errored. Passing a filtered list is
 * how a "unanimous" decline gets manufactured out of a partial view.
 */
export function planApplicationRoute(input: {
  threads: ThreadLike[];
  reply: { category: RoutableCategory; confidence?: number | null };
  minConfidence?: number;
}): RouteDecision {
  const min = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const category = String(input.reply?.category ?? "").trim().toLowerCase();
  const confidence = typeof input.reply?.confidence === "number" ? input.reply.confidence : 0;

  if (category !== "approved" && category !== "declined") {
    // Counter-offers, info requests, "submitted" acknowledgements, unknowns.
    return { move: false, reason: `not_a_decision: ${category || "empty"}` };
  }

  // A guess is not a decision. Checked before either branch so it applies to
  // approvals too — an uncertain "approved" is exactly the reading that would
  // move a deal to Approved on a lender's polite maybe.
  if (confidence < min) {
    return { move: false, reason: `low_confidence: ${confidence} < ${min}` };
  }

  if (category === "approved") {
    return { move: true, to: "approved", reason: "clean_approval" };
  }

  // ── declined ──────────────────────────────────────────────────────────────
  // Unanimity, measured over EVERY thread on the deal.
  const threads = Array.isArray(input.threads) ? input.threads : [];
  if (threads.length === 0) {
    // No thread rows means we cannot see the rest of the deal. Refusing here is
    // the difference between "every funder passed" and "we know of one funder".
    return { move: false, reason: "no_threads_visible" };
  }

  const statuses = threads.map((t) => String(t?.status ?? "").trim().toLowerCase());
  const outstanding = statuses.filter((s) => OUTSTANDING.has(s)).length;
  if (outstanding > 0) {
    return { move: false, reason: `${outstanding}_lender(s)_still_out` };
  }

  // Anything that is neither outstanding nor a decline — an approval sitting on
  // another thread, an info_requested negotiation — means this is not a dead
  // deal, whatever this one funder said.
  const nonDeclined = statuses.filter((s) => !DECLINED.has(s));
  if (nonDeclined.length > 0) {
    return { move: false, reason: `not_unanimous: ${nonDeclined.join(",")}` };
  }

  return { move: true, to: "declined", reason: `all_${statuses.length}_lenders_declined` };
}
