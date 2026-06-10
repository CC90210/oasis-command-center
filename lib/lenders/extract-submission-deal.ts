/**
 * extract-submission-deal.ts — Adon spec section 4 + 6 (2026-06-10).
 *
 * Pure extraction from tenant_records.data (the JSONB blob that holds
 * one application's fields). Returns a SubmissionDeal that the run
 * engine + the shop-out panel both feed to jordanSubject/jordanBody /
 * validateSubmissionDeal.
 *
 * Was duplicated between /api/applications/[id]/shop-out/run/route.ts
 * and app/applications/[id]/shop-out/page.tsx — extracted here so a
 * future application-schema change updates one site instead of two.
 *
 * Field-name aliases supported:
 *   merchant_legal_name | business_name — older application rows may
 *     carry the deal-shape "business_name" before Adon's spec landed.
 *
 * NaN handling: numeric fields that are missing or wrong-typed surface
 * as NaN in the returned object — that's deliberate. validateSubmissionDeal
 * downstream checks Number.isFinite() so the missing[] array surfaces
 * to the operator with the exact field names.
 */

import type { SubmissionDeal } from "@/lib/lenders/templates/jordan-submission";

export function extractSubmissionDeal(
  appData: Record<string, unknown>,
): SubmissionDeal {
  return {
    merchant_legal_name: String(
      appData.merchant_legal_name || appData.business_name || "",
    ),
    industry: String(appData.industry || ""),
    time_in_business: String(appData.time_in_business || ""),
    monthly_revenue:
      typeof appData.monthly_revenue === "number"
        ? appData.monthly_revenue
        : NaN,
    requested_amount:
      typeof appData.requested_amount === "number"
        ? appData.requested_amount
        : NaN,
    position_count:
      typeof appData.position_count === "number" ? appData.position_count : NaN,
    positions_balance:
      typeof appData.positions_balance === "number"
        ? appData.positions_balance
        : NaN,
    positions_payment:
      typeof appData.positions_payment === "number"
        ? appData.positions_payment
        : NaN,
    positions_payment_frequency: String(
      appData.positions_payment_frequency || "",
    ),
    bank_statements_months:
      typeof appData.bank_statements_months === "number"
        ? appData.bank_statements_months
        : NaN,
    bank_statements_trend: String(appData.bank_statements_trend || ""),
    narrative_summary: String(appData.narrative_summary || ""),
    open_to_best_offer:
      typeof appData.open_to_best_offer === "boolean"
        ? appData.open_to_best_offer
        : false,
    stip_labels: Array.isArray(appData.stip_labels)
      ? (appData.stip_labels as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
  };
}
