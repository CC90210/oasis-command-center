/**
 * Flattens an audit into the small struct the ranker is allowed to see.
 *
 * WHY A SEPARATE MODULE. lib/web-leads/objections/ranking.ts must stay pure and
 * cheap to test, which means it cannot take the audit object: that type is wide,
 * changes for unrelated reasons, and would drag a database import into a file
 * whose entire value is that it has none. This module is the one place that
 * knows both shapes, so an audit refactor breaks here loudly instead of
 * silently degrading the order a rep sees.
 *
 * EVERY FIELD DEGRADES TO A SAFE VALUE. A lead with no audit at all still
 * produces a valid ObjectionFacts and therefore still gets a ranked console,
 * just one ranked on family base rates alone. A rep mid-call never sees an
 * empty section because an enrichment field was missing.
 *
 * ═══ WHERE EACH INPUT ACTUALLY COMES FROM (verified against origin/main,
 * 2026-09-10 -- see task-6-report.md for the full source table) ═══════════
 *
 * This function takes already-flattened primitives, not the raw AuditResult /
 * CompetitorContext objects, so the caller (the future wiring that reads a
 * lead's audit + competitors + call log) is the one that must extract these
 * correctly. What follows is what that caller has to reach for:
 *
 *   hasWebsite    -- AuditResult.state !== "no_website" (lib/web-leads/audit.ts).
 *   overallScore  -- AuditResult (state "scored").composite. NOT "overall": an
 *                     earlier draft of this build's plan said `overall` and it
 *                     would have rendered undefined everywhere (audit.ts's own
 *                     comment on StoredProfile).
 *   dimensions    -- AuditResult (state "scored").dimensions: DimensionProfile[]
 *                     (key, label, score, weight, checks, missing). `weight` IS
 *                     present, matching selectAngle's real parameter shape.
 *   platform      -- NOT AVAILABLE. No stored field anywhere in audit.ts,
 *                     competitors.ts or the leadgen crawl signals identifies a
 *                     DIY site builder (Wix/Squarespace/etc). url-safety.ts's
 *                     PLATFORM_HOSTS list matches *hosting* platforms for URL
 *                     safety only and is never persisted as a "detected
 *                     platform" datum. Until a future task adds real
 *                     detection, callers should pass `null` here rather than
 *                     inventing a lookup -- normalisePlatform already turns
 *                     that into a safe `builderPlatform: null`.
 *   competitorGap -- Not a single field either: derived as
 *                     `headToHead.composite - audit.composite` from
 *                     CompetitorContext.headToHead (lib/web-leads/competitors.ts),
 *                     when both are known. Distinct from audit.ts's
 *                     `BenchmarkComparison`, which compares against OUR OWN
 *                     sites, not a real local competitor -- using that one
 *                     here would put "points the best-ranked competitor leads
 *                     by" next to a number about us, not them.
 *   priorNoAnswerCalls -- Not a single field: a count of this lead's call-log
 *                     rows whose outcome equals the `CallOutcome` value
 *                     "no_answer" (lib/web-leads/outcome.ts). No call-log
 *                     shape is imported here on purpose, for the same reason
 *                     the audit shape is not: this module knows the SMALL
 *                     input struct, not every upstream store.
 */

import { selectAngle } from "@/lib/web-leads/angles";
import type { ObjectionFacts } from "./types";

export function buildObjectionFacts(input: {
  hasWebsite: boolean;
  overallScore: number | null | undefined;
  dimensions: { key: string; label: string; score: number; weight: number }[] | null | undefined;
  platform: string | null | undefined;
  competitorGap: number | null | undefined;
  priorNoAnswerCalls: number | null | undefined;
}): ObjectionFacts {
  const dimensions = (input.dimensions || []).map((d) => ({
    key: d.key,
    score: d.score,
    weight: d.weight,
  }));

  const angle = input.dimensions && input.dimensions.length > 0 ? selectAngle(input.dimensions) : null;

  return {
    hasWebsite: input.hasWebsite,
    overallScore: typeof input.overallScore === "number" ? input.overallScore : null,
    dimensions,
    builderPlatform: normalisePlatform(input.platform),
    competitorGap: typeof input.competitorGap === "number" ? input.competitorGap : null,
    priorNoAnswerCalls: typeof input.priorNoAnswerCalls === "number" ? input.priorNoAnswerCalls : 0,
    selectedAngleKey: angle ? angle.key : null,
  };
}

/**
 * DIY builders only. A custom or agency-built site does not raise the nephew
 * objection, so a platform string we do not recognise returns null rather than
 * itself: an unrecognised value must not accidentally satisfy a truthy check
 * in the ranker.
 */
const BUILDERS = ["wix", "squarespace", "weebly", "godaddy", "shopify", "wordpress.com", "jimdo", "webflow"];

function normalisePlatform(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  const hit = BUILDERS.find((b) => lower.includes(b));
  return hit || null;
}
