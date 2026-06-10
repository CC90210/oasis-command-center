/**
 * Jordan's submission template — Adon spec section 6 (2026-06-10).
 *
 * Byte-for-byte format. The verification gate (item 6) snapshots this
 * against a fixture deal — any drift in wording, em-dash placement,
 * dollar formatting, or signature shape WILL fail the snapshot.
 *
 * Rules baked into the renderer:
 *   - Em dash (—) only in the Subject. Body uses regular hyphens / none.
 *   - Dollar amounts: thousand separators, no decimals (e.g. $75,000).
 *   - Empty signer.phone: omit that line entirely (no blank gap).
 *   - Empty stip labels: omit those lines entirely (no blank gap before
 *     "Please advise…").
 */

export type SubmissionDeal = {
  /** "ABC Holdings LLC" — top of subject, body header. */
  merchant_legal_name: string;
  /** "Plumbing", "Trucking", etc. Subject pipe-separated middle field. */
  industry: string;
  /** "5 years", "18 months" — raw operator string, no math here. */
  time_in_business: string;
  /** Monthly revenue in USD as a number (integer or float — we floor it). */
  monthly_revenue: number;
  /** Requested funding amount in USD. Top of subject, body header. */
  requested_amount: number;
  /** Number of existing MCA positions on the file. */
  position_count: number;
  /** Total remaining balance across positions in USD. */
  positions_balance: number;
  /** Per-payment amount in USD. */
  positions_payment: number;
  /** "Daily", "Weekly", "Monthly" — capitalized verbatim by the broker. */
  positions_payment_frequency: string;
  /** "3", "4", "6" — number of bank statement months attached. */
  bank_statements_months: number;
  /** Free-text trend signal — "growing month-over-month", "seasonal Q3 dip". */
  bank_statements_trend: string;
  /** Narrative summary — broker's pitch paragraph. Newlines preserved. */
  narrative_summary: string;
  /** Boolean — operator-set flag. Surfaced in the body when true. */
  open_to_best_offer: boolean;
  /**
   * Optional extra documents attached beyond bank statements + application.
   * Each entry becomes a "- {label}" line in the Documents attached block.
   * Empty array → no extra lines (no trailing blank line before
   * "Please advise…"). Strings only; the operator types these per-deal.
   */
  stip_labels?: string[];
};

export type SubmissionSigner = {
  /** "Jordan" / "SunBiz Submissions" — display name in the sign-off. */
  name: string;
  /** Always rendered. submissions@sunbizfunding.com or the agent's address. */
  email: string;
  /** Phone — if empty string, the phone line is omitted entirely. */
  phone: string;
};

/**
 * Format a USD amount with thousand separators and no decimals.
 * `Intl.NumberFormat` matches Adon's spec wording ($75,000 not $75000.00).
 * Negative amounts shouldn't occur in this domain but render naturally
 * if they do (helpful for diagnosing data corruption).
 */
function formatUsd(amount: number): string {
  // Floor to integer USD per Adon's "no decimals" rule. Banks may report
  // monthly revenue with cents; we drop them here for the wire copy.
  const rounded = Math.trunc(amount);
  return `$${rounded.toLocaleString("en-US")}`;
}

/**
 * Render the subject. Format (spec 6):
 *   New Submission — {merchant_legal_name} | {industry} | ${requested_amount}
 *
 * The em-dash (—, U+2014) appears here and ONLY here. Body never uses one.
 */
export function jordanSubject(deal: Pick<SubmissionDeal,
  "merchant_legal_name" | "industry" | "requested_amount">): string {
  return `New Submission — ${deal.merchant_legal_name} | ${deal.industry} | ${formatUsd(deal.requested_amount)}`;
}

/**
 * Render the body (spec 6). Per-funder substitution happens at the
 * caller — the funder_name is the only per-lender field, everything
 * else is the same deal-wide content.
 */
export function jordanBody(
  deal: SubmissionDeal,
  signer: SubmissionSigner,
  funderName: string,
): string {
  const lines: string[] = [];
  lines.push(`Hi ${funderName},`);
  lines.push("");
  lines.push("Please see the following submission for your review:");
  lines.push("");
  lines.push(`Business Name: ${deal.merchant_legal_name}`);
  lines.push(`Industry: ${deal.industry}`);
  lines.push(`Time in Business: ${deal.time_in_business}`);
  lines.push(`Monthly Revenue: ${formatUsd(deal.monthly_revenue)}`);
  lines.push(`Requested Amount: ${formatUsd(deal.requested_amount)}`);
  lines.push(
    `Existing Positions: ${deal.position_count} | Remaining Balance: ${formatUsd(deal.positions_balance)} | ${deal.positions_payment_frequency} Payment: ${formatUsd(deal.positions_payment)}`,
  );
  lines.push("");
  lines.push("Summary:");
  lines.push(deal.narrative_summary);
  lines.push("");
  lines.push("Documents attached:");
  lines.push(`- Bank Statements (${deal.bank_statements_months} months)`);
  lines.push("- Application");
  // Stip labels: each becomes its own "- {label}" line. No trailing blank
  // line before "Please advise" — Adon spec 6 rule is explicit about this.
  const stips = (deal.stip_labels || []).filter((s) => s && s.trim().length > 0);
  for (const stip of stips) {
    lines.push(`- ${stip.trim()}`);
  }
  lines.push("");
  lines.push("Please advise on appetite and best offer.");
  lines.push("");
  lines.push("Thank you,");
  lines.push(signer.name);
  lines.push("SunBiz Funding LLC");
  lines.push(signer.email);
  // Phone is conditionally rendered. Empty-string phone means the line
  // disappears entirely (no blank gap, no placeholder).
  if (signer.phone && signer.phone.trim().length > 0) {
    lines.push(signer.phone.trim());
  }
  return lines.join("\n");
}

/**
 * Validate that a deal has every field the template needs. Returns the
 * list of missing field names; empty array means valid.
 *
 * Spec section 8 verification item #7 requires 400 + {missing: [...]}
 * when a field is null — the run endpoint calls this before any send.
 */
export function validateSubmissionDeal(
  deal: Partial<SubmissionDeal>,
): string[] {
  const missing: string[] = [];
  if (!deal.merchant_legal_name || !deal.merchant_legal_name.trim()) {
    missing.push("merchant_legal_name");
  }
  if (!deal.industry || !deal.industry.trim()) missing.push("industry");
  if (!deal.time_in_business || !deal.time_in_business.trim()) {
    missing.push("time_in_business");
  }
  if (typeof deal.monthly_revenue !== "number" || !Number.isFinite(deal.monthly_revenue)) {
    missing.push("monthly_revenue");
  }
  if (typeof deal.requested_amount !== "number" || !Number.isFinite(deal.requested_amount)) {
    missing.push("requested_amount");
  }
  if (typeof deal.position_count !== "number" || !Number.isFinite(deal.position_count)) {
    missing.push("position_count");
  }
  if (typeof deal.positions_balance !== "number" || !Number.isFinite(deal.positions_balance)) {
    missing.push("positions_balance");
  }
  if (typeof deal.positions_payment !== "number" || !Number.isFinite(deal.positions_payment)) {
    missing.push("positions_payment");
  }
  if (!deal.positions_payment_frequency || !deal.positions_payment_frequency.trim()) {
    missing.push("positions_payment_frequency");
  }
  if (typeof deal.bank_statements_months !== "number" || !Number.isFinite(deal.bank_statements_months)) {
    missing.push("bank_statements_months");
  }
  if (!deal.bank_statements_trend || !deal.bank_statements_trend.trim()) {
    missing.push("bank_statements_trend");
  }
  if (!deal.narrative_summary || !deal.narrative_summary.trim()) {
    missing.push("narrative_summary");
  }
  if (typeof deal.open_to_best_offer !== "boolean") {
    missing.push("open_to_best_offer");
  }
  return missing;
}
