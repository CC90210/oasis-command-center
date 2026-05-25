/**
 * lenders/match-narrative.ts — plain-English narrative explaining why
 * a lender ranked where it did against a specific application.
 *
 * 2026-05-25 (second SunBiz product meeting): operator-facing lender
 * list now shows 1-3 sentences of prose per lender so the SunBiz team
 * can read the ranking at a glance instead of parsing raw score + bullet
 * lists. Pure function — no DB calls. Call it after scoring.
 *
 * Tone rules (enforced by the "AI Slop Detection" gate in CLAUDE.md):
 *   - No "great choice", "perfect fit", "amazing", "synergy", or any
 *     marketing cheerleader language.
 *   - Numbers must be specific ($45k, FICO 720, 8mo TIB) — never
 *     "high revenue" or "good FICO".
 *   - Every sentence must add information. No padding.
 *   - Score < 50 always ends with a "what to do" beat.
 */

import type { MatchScore, LenderProfile, ApplicationProfile } from "./match-fitness";

/**
 * Build a 1-3 sentence plain-English narrative explaining why `lender`
 * ranked at `score.score` against `application`. Pure function — no
 * side effects, no DB calls.
 *
 * Algorithm:
 *   1. Choose opener tone: strong (>70), hedged (40-70), long shot (<40
 *      or any high_risk warning present).
 *   2. Add the most load-bearing positive signals (reasons) — up to 3,
 *      picking the most specific ones.
 *   3. Integrate the most important negative signal (warning) if present.
 *   4. Append a "what to do" beat if score < 50.
 */
export function buildLenderNarrative(
  score: MatchScore,
  lender: LenderProfile,
  _application: ApplicationProfile,
): string {
  const hasHighRisk = score.warnings.some((w) => w.severity === "high_risk");
  const name = lender.name || "This lender";

  // Edge: no data at all.
  if (score.reasons.length === 0 && score.warnings.length === 0) {
    return "Insufficient data on this lender — review manually before sending.";
  }

  // Edge: perfect score, no warnings.
  if (score.score === 100 && score.warnings.length === 0) {
    const detail = score.reasons.length > 0
      ? ` — ${summariseReasons(score.reasons, 2)}.`
      : ".";
    return `${name} is a strong fit on all hard gates${detail} Send confidently.`;
  }

  // Determine opener tier.
  const isLongShot = hasHighRisk || score.score < 40;
  const isHedged = !isLongShot && (score.score >= 40 && score.score < 70);
  const isStrong = !isLongShot && !isHedged; // score >= 70

  // Build opener.
  let opener: string;
  if (isStrong) {
    opener = `${name} is a strong fit`;
  } else if (isHedged) {
    opener = `${name} is a moderate fit`;
  } else {
    opener = `${name} is a long shot`;
  }

  const parts: string[] = [];

  // Positive signals — take up to 2, most informative first (revenue,
  // FICO, TIB, product, SLA in priority order).
  const positiveDetail = selectPositiveDetail(score.reasons);
  if (positiveDetail) {
    parts.push(`${opener} — ${positiveDetail}`);
  } else {
    parts.push(`${opener}`);
  }

  // Negative signals — the most severe first.
  const negativeDetail = selectNegativeDetail(score.warnings);
  if (negativeDetail) {
    // If there were also positives, start a new sentence for contrast.
    if (positiveDetail) {
      parts.push(negativeDetail);
    } else {
      // No positive context — fold the negative into the opener sentence.
      parts[0] = `${opener}: ${negativeDetail}`;
    }
  }

  // SLA visibility (only if not already in reasons summary).
  const slaReason = score.reasons.find((r) => r.startsWith("SLA:"));
  if (slaReason && !positiveDetail?.includes("SLA")) {
    parts.push(slaReason.replace(/^SLA:\s*/, "Typical ") + ".");
  }

  // "What to do" beat for score < 50 or high_risk.
  if (score.score < 50 || hasHighRisk) {
    parts.push(buildActionBeat(score, hasHighRisk));
  }

  return parts.join(" ").replace(/\s{2,}/g, " ").trim();
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Pick the 2 most informative reasons to include in the opener clause.
 * Priority: revenue > FICO > TIB > product > SLA.
 */
function selectPositiveDetail(reasons: string[]): string | null {
  const priority = ["Revenue", "FICO", "TIB", "Product", "SLA"];
  const picked: string[] = [];
  for (const prefix of priority) {
    if (picked.length >= 2) break;
    const match = reasons.find((r) => r.startsWith(prefix));
    if (match) picked.push(match);
  }
  if (picked.length === 0) {
    // Fall back to first two reasons if none match priority prefixes.
    const fallback = reasons.slice(0, 2);
    if (fallback.length === 0) return null;
    picked.push(...fallback);
  }
  return picked.join(", ").replace(/\.$/, "");
}

/**
 * Summarise reasons for the perfect-score edge case.
 * Takes up to `limit` reasons and joins them.
 */
function summariseReasons(reasons: string[], limit: number): string {
  return reasons.slice(0, limit).join("; ").replace(/\.$/, "");
}

/**
 * Pick the most impactful negative signal to surface in the narrative.
 * High-risk always wins; within the same tier, pick the first one
 * (scoring already surfaces the most critical first).
 */
function selectNegativeDetail(warnings: Array<{ severity: string; code: string; detail: string }>): string | null {
  const highRisk = warnings.find((w) => w.severity === "high_risk");
  if (highRisk) return highRisk.detail;
  const warn = warnings.find((w) => w.severity === "warning");
  if (warn) return warn.detail;
  // Info-tier warnings aren't surfaced in narrative prose — they're
  // already visible as chips in the UI.
  return null;
}

/**
 * Returns a closing "what to do" sentence for low-score / high-risk
 * lenders. Specific phrasing depends on the failure mode.
 */
function buildActionBeat(
  score: MatchScore,
  hasHighRisk: boolean,
): string {
  if (hasHighRisk) {
    // High-risk: operator needs a direct relationship to proceed.
    return "Send only if you have a direct line with their underwriter.";
  }
  // Warning-tier: worth trying but with caveats.
  const hasCapWarning = score.warnings.some((w) => w.code === "exceeds_max_funded");
  if (hasCapWarning) {
    return "Expect a counter-offer at their cap — confirm the client can work with a lower amount before sending.";
  }
  const hasProductMismatch = score.warnings.some((w) => w.code === "product_mismatch");
  if (hasProductMismatch) {
    return "Skip unless you've confirmed they'll consider the deal outside their listed products.";
  }
  // Generic low-score guidance.
  if (score.score < 30) {
    return "Skip unless other options are exhausted.";
  }
  return "Consider with caveat — verify requirements before sending.";
}
