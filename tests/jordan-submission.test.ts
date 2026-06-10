/**
 * Tests for lib/lenders/templates/jordan-submission.ts.
 *
 * Adon spec section 8 verification item #6: "Template snapshot test:
 * byte-for-byte match against fixture deal". A drift in the template
 * wording, em-dash placement, dollar formatting, or signature shape
 * MUST fail this test — that's the gate that keeps Jordan's exact
 * submission format from quietly mutating.
 *
 * Also covers Adon spec rules:
 *   - Em dash (—) only in subject; body uses regular hyphens
 *   - Dollar amounts: thousand separators, no decimals
 *   - Empty signer.phone: phone line omitted entirely (no blank gap)
 *   - Empty stip_labels: those lines omitted (no blank gap before
 *     "Please advise…")
 *   - validateSubmissionDeal: returns the full missing[] for a degraded
 *     deal so the run endpoint can 400 with explicit feedback
 */

import assert from "node:assert/strict";
import {
  jordanSubject,
  jordanBody,
  validateSubmissionDeal,
  type SubmissionDeal,
  type SubmissionSigner,
} from "../lib/lenders/templates/jordan-submission";

const FIXTURE_DEAL: SubmissionDeal = {
  merchant_legal_name: "ABC Holdings LLC",
  industry: "Plumbing",
  time_in_business: "5 years",
  monthly_revenue: 145000,
  requested_amount: 75000,
  position_count: 2,
  positions_balance: 18500,
  positions_payment: 1200,
  positions_payment_frequency: "Daily",
  bank_statements_months: 3,
  bank_statements_trend: "growing month-over-month",
  narrative_summary:
    "Strong service-trades operator with 5 years in business and stable seasonal cash flow.\nClean banking; no NSFs in the last 90 days.",
  open_to_best_offer: true,
  stip_labels: ["Voided Check", "Driver's License"],
};

const SIGNER_JORDAN: SubmissionSigner = {
  name: "Jordan",
  email: "jordan@sunbizfunding.com",
  phone: "786-386-4301",
};

const SIGNER_SHARED: SubmissionSigner = {
  name: "SunBiz Submissions",
  email: "submissions@sunbizfunding.com",
  phone: "",
};

// ─────────────────────────────────────────────────────────────────────
// Subject — em-dash + thousand separators
// ─────────────────────────────────────────────────────────────────────
{
  const subject = jordanSubject(FIXTURE_DEAL);
  const expected = "New Submission — ABC Holdings LLC | Plumbing | $75,000";
  assert.equal(subject, expected, "subject byte-match");
  assert.ok(subject.includes("—"), "subject MUST include em dash (U+2014)");
}

// ─────────────────────────────────────────────────────────────────────
// Body — full byte snapshot with Jordan as signer (with phone)
// ─────────────────────────────────────────────────────────────────────
{
  const body = jordanBody(FIXTURE_DEAL, SIGNER_JORDAN, "Bigfoot Capital");
  const expected = [
    "Hi Bigfoot Capital,",
    "",
    "Please see the following submission for your review:",
    "",
    "Business Name: ABC Holdings LLC",
    "Industry: Plumbing",
    "Time in Business: 5 years",
    "Monthly Revenue: $145,000",
    "Requested Amount: $75,000",
    "Existing Positions: 2 | Remaining Balance: $18,500 | Daily Payment: $1,200",
    "",
    "Summary:",
    "Strong service-trades operator with 5 years in business and stable seasonal cash flow.",
    "Clean banking; no NSFs in the last 90 days.",
    "",
    "Documents attached:",
    "- Bank Statements (3 months)",
    "- Application",
    "- Voided Check",
    "- Driver's License",
    "",
    "Please advise on appetite and best offer.",
    "",
    "Thank you,",
    "Jordan",
    "SunBiz Funding LLC",
    "jordan@sunbizfunding.com",
    "786-386-4301",
  ].join("\n");
  assert.equal(body, expected, "body byte-match with Jordan signer");
  assert.ok(!body.includes("—"), "body MUST NOT include em dash (subject only)");
}

// ─────────────────────────────────────────────────────────────────────
// Body — shared-identity signer, empty phone → phone line OMITTED
// ─────────────────────────────────────────────────────────────────────
{
  const body = jordanBody(FIXTURE_DEAL, SIGNER_SHARED, "Riverstone Capital");
  const lines = body.split("\n");
  // Last three lines should be name, "SunBiz Funding LLC", email — no phone line.
  assert.equal(lines[lines.length - 3], "SunBiz Submissions");
  assert.equal(lines[lines.length - 2], "SunBiz Funding LLC");
  assert.equal(lines[lines.length - 1], "submissions@sunbizfunding.com");
  // No trailing blank line; no rogue 786- digits anywhere in the body.
  assert.ok(!body.includes("786-"), "empty phone must not surface anywhere");
}

// ─────────────────────────────────────────────────────────────────────
// Body — no stip labels → no extra lines, no blank gap before "Please advise…"
// ─────────────────────────────────────────────────────────────────────
{
  const dealNoStips: SubmissionDeal = { ...FIXTURE_DEAL, stip_labels: [] };
  const body = jordanBody(dealNoStips, SIGNER_JORDAN, "Lighthouse Funding");
  // "- Application" should be IMMEDIATELY followed by "" then "Please advise…"
  // (no extra "- ..." lines in between).
  const appIdx = body.indexOf("\n- Application\n");
  assert.ok(appIdx !== -1, "Application line present");
  const afterApp = body.slice(appIdx + "\n- Application\n".length);
  assert.ok(
    afterApp.startsWith("\nPlease advise on appetite and best offer."),
    "no blank gap or stray dash lines between Application and Please advise",
  );
}

// ─────────────────────────────────────────────────────────────────────
// validateSubmissionDeal — full happy + degraded cases
// ─────────────────────────────────────────────────────────────────────
{
  // Happy path — no missing fields.
  const missing = validateSubmissionDeal(FIXTURE_DEAL);
  assert.deepEqual(missing, [], "complete deal returns empty missing[]");
}
{
  // monthly_revenue null — Adon spec 8.7 demands this exact case fail with
  // explicit feedback.
  const broken = { ...FIXTURE_DEAL, monthly_revenue: null as unknown as number };
  const missing = validateSubmissionDeal(broken);
  assert.ok(missing.includes("monthly_revenue"), "null monthly_revenue surfaces");
}
{
  // Completely empty payload — every required field surfaces.
  const missing = validateSubmissionDeal({});
  const expectedKeys = [
    "merchant_legal_name",
    "industry",
    "time_in_business",
    "monthly_revenue",
    "requested_amount",
    "position_count",
    "positions_balance",
    "positions_payment",
    "positions_payment_frequency",
    "bank_statements_months",
    "bank_statements_trend",
    "narrative_summary",
    "open_to_best_offer",
  ];
  for (const key of expectedKeys) {
    assert.ok(missing.includes(key), `empty payload surfaces ${key}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Dollar formatting — thousands separators, no decimals (Adon spec rule)
// ─────────────────────────────────────────────────────────────────────
{
  const deal: SubmissionDeal = { ...FIXTURE_DEAL, monthly_revenue: 1234567.89 };
  const body = jordanBody(deal, SIGNER_JORDAN, "Test");
  assert.ok(
    body.includes("Monthly Revenue: $1,234,567"),
    "dollar formatting: thousand separators + no decimals",
  );
  assert.ok(
    !body.includes("1,234,567.89"),
    "decimals must be truncated, not rendered",
  );
}

console.log("jordan-submission: all assertions passed");
