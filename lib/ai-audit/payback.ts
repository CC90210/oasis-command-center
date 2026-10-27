/**
 * Payback, claimed only where it holds (review of #759): the full one-time price, never only a deposit; against
 * revenue the priced work itself produces, never staff time and never work left out of the total; less any monthly
 * fee; from an estimate the audit shows, per month, in the currency CC recorded for the client's figures, which must
 * be the proposal's. Where that cannot be shown, nothing is claimed.
 */
import type { AuditDoc, DocEstimate } from "@/lib/ai-audit/doc";
import { REVENUE_ESTIMATES } from "@/lib/ai-audit/impact";
import { itemFamily, skuForOpportunity } from "@/lib/ai-audit/opportunities";
import type { ProposalContent, ProposalTotals } from "@/lib/ai-audit/proposal";

/** A period CC can type that means one month: "per month", "a month", "each month", "monthly". */
const MONTHLY = /^\s*(?:(?:per|a|each|every) month|monthly)\s*$/i;

export type Payback = { estimate: DocEstimate; investment: number; monthlyFees: number; fast: number; slow: number };

/** "1 month", "3 months", "3 to 7 months": both ends said once when they round to the same month (CodeRabbit, #759). */
export function monthsWords(fast: number, slow: number): string {
  const n = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;
  return fast === slow ? n(slow) : `${fast} to ${n(slow)}`;
}

export function paybackFor(doc: AuditDoc, proposal: ProposalContent, totals: ProposalTotals): Payback | null {
  if (proposal.lines.some((l) => l.kind === "needs_owner_price") || totals.total_cents <= 0) return null;
  // The client's "$450 a job" is in their currency, the price in the proposal's: no ratio without both the same.
  if (!doc.business.currency || doc.business.currency !== proposal.currency) return null;
  const shown = new Set(doc.sections.impact.estimate_ids);
  // The catalogue items in the total (a tier CC changed still counts: launch or scale, it is the same setter).
  const included = new Set(proposal.lines.flatMap((l) => (l.kind === "catalogue" && !l.optional && l.unit !== "per_month" ? [itemFamily(l.sku)] : [])));
  const paidFor = new Set(
    doc.sections.opportunities.items
      .filter((o) => {
        const sku = skuForOpportunity(o.id, doc);
        return !!sku && included.has(itemFamily(sku));
      })
      .flatMap((o) => o.estimate_ids),
  );
  const estimate = doc.estimates
    .filter((e) => shown.has(e.id) && paidFor.has(e.id) && REVENUE_ESTIMATES.has(e.id) && e.unit === "$" && MONTHLY.test(e.period ?? ""))
    .sort((a, b) => b.high - a.high)[0];
  if (!estimate) return null;
  const investment = totals.total_cents / 100;
  const monthlyFees = totals.monthly_cents / 100;
  const low = estimate.low - monthlyFees;
  const high = estimate.high - monthlyFees;
  if (low <= 0) return null;
  return { estimate, investment, monthlyFees, fast: Math.max(1, Math.ceil(investment / high)), slow: Math.max(1, Math.ceil(investment / low)) };
}
