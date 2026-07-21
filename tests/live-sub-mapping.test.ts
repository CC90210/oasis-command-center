/**
 * live-sub-mapping.test.ts — end-to-end guard for the Breeze Live Subs
 * lead_data → application field mapping (2026-07-17 D5/D6/D7 fix).
 *
 * Input shapes mirror the REAL output of the VPS scrubber build_lead_data
 * (SunBiz-Agent scripts/mca_lead_scrubber.py), verified against live
 * scrub_candidates rows. Locks down:
 *   - TIB: time_in_business_months lands as MONTHS (a number), and
 *     business_start_date is NEVER polluted with a non-date tib string (D5).
 *   - iso_broker / positions_payment / positions_payment_frequency /
 *     leverage_ratio / time_in_business now survive onto the application (D7).
 *   - business_state normalizes to the 2-letter code; applicant_fico maps from
 *     credit_score.
 *   - reconcileLiveSubFields flags genuinely-empty critical fields (D6).
 */
import assert from "node:assert";
import {
  mapLeadDataToApplicationFields,
  reconcileLiveSubFields,
} from "../lib/applications/live-sub-mapping";
import { extractAppFields } from "../lib/forms/application-upsert";

/** Simulate the promote path: map lead_data → canonical, then normalize. */
function toAppFields(leadData: Record<string, unknown>): Record<string, unknown> {
  const mapped = mapLeadDataToApplicationFields(leadData);
  return extractAppFields({ ...leadData, ...mapped });
}

function run() {
  // ── Case 1: a typical live sub — tib is a real start DATE ────────────────
  // (build_lead_data emits business_start_date + time_in_business_months from a
  // real date; PII is 0-filled as ISO sheets carry no contact.)
  const lead1 = {
    business_name: "ACME LLC", company: "ACME LLC", legal_name: "ACME LLC", business_legal_name: "ACME LLC",
    ein: "12-3456789", entity_type: "LLC", industry: "Retail",
    tib: "2021-03-19 00:00:00", business_start_date: "2021-03-19",
    time_in_business_months: 63, time_in_business: "5 years, 3 months",
    monthly_revenue: 170124.16, avg_monthly_revenue: 170124.16, true_revenue_monthly: 170124.16,
    mca_positions: 2, open_mca_positions: 2, position_count: 2,
    positions_payment: 430, positions_payment_frequency: "Daily", leverage_ratio: 25.5,
    iso_broker: "PArk Capital",
    state: "Arizona", state_code: "AZ", business_state: "Arizona", business_state_code: "AZ",
    credit_score: 720, owner_credit_score: 720,
    owner_name: "Jane Doe", contact_name: "Jane Doe", name: "Jane Doe",
    email: "", phone: "",
    stage: "uw_sheet", status: "new",
  };
  const a = toAppFields(lead1);

  assert.strictEqual(a.business_start_date, "2021-03-19", "business_start_date = real ISO date");
  assert.strictEqual(a.time_in_business_months, 63, "TIB months is a NUMBER of months");
  assert.strictEqual(a.time_in_business, "5 years, 3 months", "time_in_business label carried (lender submission)");
  assert.strictEqual(a.iso_broker, "PArk Capital", "iso_broker now lands on the application");
  assert.strictEqual(a.positions_payment, 430, "positions_payment carried");
  assert.strictEqual(a.positions_payment_frequency, "Daily", "positions_payment_frequency carried");
  assert.strictEqual(a.leverage_ratio, 25.5, "leverage_ratio carried");
  assert.strictEqual(a.business_state, "AZ", "business_state normalized to 2-letter code");
  assert.strictEqual(a.applicant_fico, 720, "applicant_fico mapped from credit_score");
  assert.strictEqual(a.position_count, 2, "position_count carried");
  assert.strictEqual(a.tax_id_ein, "12-3456789", "EIN mapped from ein");
  // TIB must never leak the raw cell into the date field.
  assert.notStrictEqual(a.business_start_date, "2021-03-19 00:00:00", "no raw datetime in start date");

  const rec1 = reconcileLiveSubFields(a);
  assert.deepStrictEqual(rec1.missingCritical, [], "case 1: no missing critical fields");
  assert.strictEqual(rec1.severe, false, "case 1: not severe");

  // ── Case 2: pathological TIB — a duration phrase, no parseable date ───────
  // build_lead_data resolved months=120 from "Over 10 years" but produced NO
  // business_start_date. The pre-fix bug wrote "Over 10 years" into
  // business_start_date; assert that CANNOT happen now.
  const lead2 = {
    business_name: "OVER TEN INC", company: "OVER TEN INC", legal_name: "OVER TEN INC", business_legal_name: "OVER TEN INC",
    ein: "98-7654321", industry: "Construction",
    tib: "Over 10 years", time_in_business_months: 120, time_in_business: "10 years",
    monthly_revenue: 90000, true_revenue_monthly: 90000,
    position_count: 0, mca_positions: 0,
    iso_broker: "FUNDMATE", business_state: "Texas", state_code: "TX",
    owner_name: "Bob Roe", contact_name: "Bob Roe",
    email: "", phone: "",
    stage: "uw_sheet",
  };
  const b = toAppFields(lead2);
  assert.strictEqual(b.business_start_date, undefined, "D5: no garbage date from a duration tib");
  assert.strictEqual(b.time_in_business_months, 120, "months resolved from duration phrase");
  assert.strictEqual(b.business_state, "TX", "state normalized from state_code fallback");
  assert.strictEqual(b.iso_broker, "FUNDMATE", "iso_broker carried");

  // credit_score absent here → applicant_fico is legitimately blank and flagged.
  const rec2 = reconcileLiveSubFields(b);
  assert.ok(rec2.missingCritical.includes("applicant_fico"), "case 2: applicant_fico flagged missing");
  assert.ok(!rec2.severe, "case 2: not severe (business_name + monthly_revenue present)");

  // ── Case 3: severe — a broken sub missing business_name + revenue ────────
  const c = toAppFields({ iso_broker: "X", position_count: 1, stage: "uw_sheet" });
  const rec3 = reconcileLiveSubFields(c);
  assert.ok(rec3.severe, "case 3: severe when business_name + monthly_revenue blank");
  assert.ok(rec3.missingCritical.includes("business_name"), "case 3: business_name flagged");
  assert.ok(rec3.missingCritical.includes("monthly_revenue"), "case 3: monthly_revenue flagged");

  // ── Case 4: business address is composed whole (2026-07-21) ──────────────
  // The application entity has ONE free-text address field, so the street line
  // alone silently dropped the city + ZIP off every generated application/PDF.
  const d = toAppFields({
    business_name: "Shoal Creek Tavern LLC",
    monthly_revenue: 228423,
    business_address_line1: "1701 SHOAL CREEK DR STE 100",
    business_address: "1701 SHOAL CREEK DR STE 100",
    business_city: "HIGHLAND VILLAGE",
    business_zip: "75077",
    business_address_state: "TX",
    state: "Texas",
  });
  assert.equal(
    d.business_address,
    "1701 SHOAL CREEK DR STE 100, HIGHLAND VILLAGE 75077",
    "case 4: street + city + zip composed onto the single address field",
  );
  // State is NOT in the line — application-pdf.composeAddress splices it in at
  // render time, so including it here would print it twice.
  assert.ok(!String(d.business_address).includes("TX"), "case 4: state excluded from the address line");
  assert.equal(d.business_state, "TX", "case 4: business_address_state wins over the full name");

  // Re-running the mapper over an ALREADY-composed address must be idempotent.
  const dAgain = toAppFields({
    business_name: "Shoal Creek Tavern LLC",
    business_address: "1701 SHOAL CREEK DR STE 100, HIGHLAND VILLAGE 75077",
    business_city: "HIGHLAND VILLAGE",
    business_zip: "75077",
  });
  assert.equal(
    dAgain.business_address,
    "1701 SHOAL CREEK DR STE 100, HIGHLAND VILLAGE 75077",
    "case 4: composing an already-complete address does not duplicate parts",
  );

  // ── Case 5: ownership % is stamped 100, never inherited (2026-07-21) ─────
  assert.equal(d.owner_ownership_pct, 100, "case 5: ownership defaults to 100 when absent");
  const e = toAppFields({ business_name: "X", monthly_revenue: 1, owner_ownership_pct: 51 });
  assert.equal(e.owner_ownership_pct, 100, "case 5: a lead-side ownership value is overridden to 100");
  const f = toAppFields({ business_name: "X", monthly_revenue: 1, ownership_pct: 33 });
  assert.equal(f.owner_ownership_pct, 100, "case 5: the ownership_pct alias is overridden too");

  console.log("live-sub-mapping.test.ts — all assertions passed ✓");
}

run();
