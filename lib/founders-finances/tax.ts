/**
 * GST/QST rules and the small-supplier threshold tracker. PURE.
 *
 * OASIS IS NOT REGISTERED (small supplier, 2026-09-24). With
 * gst_qst_registered = false every tax amount below is zero and invoices carry
 * no tax lines. The codes stay in the schema, dormant, until a founder turns
 * registration on in Finances > Settings and enters both numbers.
 *
 * Quebec since 2013: GST 5% and QST 9.975% are BOTH computed on the pre-tax
 * amount (no tax-on-tax). Each is rounded to the cent on the invoice subtotal,
 * half away from zero — computing per line and summing can drift a cent from
 * what the customer's own calculator says.
 *
 * SMALL SUPPLIER TEST (Excise Tax Act s.148, mirrored by the QST Act): a
 * person stops being a small supplier when worldwide taxable supplies exceed
 * CA$30,000 in a single calendar quarter, or over the last four consecutive
 * calendar quarters. Zero-rated exports (a US client) COUNT toward it.
 */

import { divRoundHalfAwayFromZero } from "./money";

export const GST_RATE_PPM = 50_000; // 5%
export const QST_RATE_PPM = 99_750; // 9.975%
export const SMALL_SUPPLIER_THRESHOLD_CENTS = 3_000_000; // CA$30,000

export function taxAtPpm(amountCents: number, ratePpm: number): number {
  if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(ratePpm)) {
    throw new Error("tax inputs must be integers");
  }
  return Number(divRoundHalfAwayFromZero(BigInt(amountCents) * BigInt(ratePpm), BigInt(1_000_000)));
}

export type SalesTax = { gstCents: number; qstCents: number; taxCents: number };

export function computeSalesTax(taxableSubtotalCents: number, registered: boolean): SalesTax {
  if (!registered || taxableSubtotalCents === 0) return { gstCents: 0, qstCents: 0, taxCents: 0 };
  const gstCents = taxAtPpm(taxableSubtotalCents, GST_RATE_PPM);
  const qstCents = taxAtPpm(taxableSubtotalCents, QST_RATE_PPM);
  return { gstCents, qstCents, taxCents: gstCents + qstCents };
}

/**
 * Registration may only be switched ON with both numbers present and
 * plausibly shaped. GST/HST: 9-digit BN + "RT" + 4 digits. QST: 10 digits +
 * "TQ" + 4 digits. Spaces are tolerated and stripped.
 */
export function validateRegistration(input: {
  registered: boolean;
  gstNumber: string;
  qstNumber: string;
}): { ok: true; gstNumber: string; qstNumber: string } | { ok: false; error: string } {
  const gst = (input.gstNumber || "").replace(/\s+/g, "").toUpperCase();
  const qst = (input.qstNumber || "").replace(/\s+/g, "").toUpperCase();
  if (!input.registered) return { ok: true, gstNumber: gst, qstNumber: qst };
  if (!/^\d{9}RT\d{4}$/.test(gst)) {
    return { ok: false, error: "GST number must look like 123456789RT0001 before registration can be turned on" };
  }
  if (!/^\d{10}TQ\d{4}$/.test(qst)) {
    return { ok: false, error: "QST number must look like 1234567890TQ0001 before registration can be turned on" };
  }
  return { ok: true, gstNumber: gst, qstNumber: qst };
}

export type Quarter = { label: string; from: string; to: string };

/** The calendar quarter containing `date` (ISO), as [from, to). */
export function quarterOf(date: string): Quarter {
  const y = Number(date.slice(0, 4));
  const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3);
  const fromMonth = q * 3 + 1;
  const from = `${y}-${String(fromMonth).padStart(2, "0")}-01`;
  const to = q === 3 ? `${y + 1}-01-01` : `${y}-${String(fromMonth + 3).padStart(2, "0")}-01`;
  return { label: `${y}-Q${q + 1}`, from, to };
}

/**
 * The four calendar quarters ending with the one containing `today`, oldest
 * first. The current quarter is included to date — an early warning, stricter
 * than the statutory test, which only looks back at completed quarters.
 */
export function trailingFourQuarters(today: string): Quarter[] {
  const out: Quarter[] = [];
  let q = quarterOf(today);
  for (let i = 0; i < 4; i++) {
    out.unshift(q);
    const prevDay = new Date(`${q.from}T00:00:00Z`);
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    q = quarterOf(prevDay.toISOString().slice(0, 10));
  }
  return out;
}

export type ThresholdLevel = "ok" | "watch" | "warning" | "exceeded";

export type ThresholdStatus = {
  thresholdCents: number;
  totalCents: number;
  pct: number;
  level: ThresholdLevel;
  singleQuarterExceeded: string | null;
  quarters: Array<{ label: string; revenueCents: number }>;
  message: string;
};

/** watch at 75%, warning at 90%, exceeded above 100% (or any single quarter over). */
export function smallSupplierStatus(
  quarters: ReadonlyArray<{ label: string; revenueCents: number }>,
  thresholdCents = SMALL_SUPPLIER_THRESHOLD_CENTS,
): ThresholdStatus {
  const totalCents = quarters.reduce((a, q) => a + Math.max(0, q.revenueCents), 0);
  const pct = thresholdCents > 0 ? totalCents / thresholdCents : 0;
  const single = quarters.find((q) => q.revenueCents > thresholdCents) || null;
  let level: ThresholdLevel = "ok";
  if (single || totalCents > thresholdCents) level = "exceeded";
  else if (pct >= 0.9) level = "warning";
  else if (pct >= 0.75) level = "watch";
  const pctLabel = `${Math.round(pct * 1000) / 10}%`;
  const message =
    level === "exceeded"
      ? single
        ? `Taxable revenue in ${single.label} alone passed CA$30,000 — registration for GST/QST is required from the supply that crossed it. Talk to the accountant now.`
        : `Taxable revenue over the last four quarters passed CA$30,000 (${pctLabel}). You must register for GST/QST within 29 days of the end of the month you crossed it.`
      : level === "warning"
        ? `At ${pctLabel} of the CA$30,000 small-supplier threshold. Plan registration now.`
        : level === "watch"
          ? `At ${pctLabel} of the CA$30,000 small-supplier threshold.`
          : `At ${pctLabel} of the CA$30,000 small-supplier threshold. No action needed.`;
  return {
    thresholdCents,
    totalCents,
    pct,
    level,
    singleQuarterExceeded: single ? single.label : null,
    quarters: quarters.map((q) => ({ label: q.label, revenueCents: q.revenueCents })),
    message,
  };
}

export type GstQstPeriodReport = {
  gstCollectedCents: number;
  qstCollectedCents: number;
  gstItcCents: number;
  qstItrCents: number;
  gstNetCents: number;
  qstNetCents: number;
  meaningful: boolean;
};

/** Net tax = collected on sales minus input tax credits/refunds on purchases. */
export function gstQstPeriodReport(input: {
  registered: boolean;
  gstCollectedCents: number;
  qstCollectedCents: number;
  gstItcCents: number;
  qstItrCents: number;
}): GstQstPeriodReport {
  return {
    gstCollectedCents: input.gstCollectedCents,
    qstCollectedCents: input.qstCollectedCents,
    gstItcCents: input.gstItcCents,
    qstItrCents: input.qstItrCents,
    gstNetCents: input.gstCollectedCents - input.gstItcCents,
    qstNetCents: input.qstCollectedCents - input.qstItrCents,
    meaningful: input.registered,
  };
}
