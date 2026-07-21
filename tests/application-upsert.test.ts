/**
 * application-upsert.test.ts — guards the form → application field mapping
 * (2026-06-20). The bug it locks down: only 12 whitelisted keys used to survive
 * onto the application record, so owner/business detail vanished and the drawer
 * showed "Owner / Signer —". These tests assert the full set persists AND that
 * the form's owner_/business_legal_ names also land under the reader-canonical
 * keys (owner_name / contact_name / business_name / phone).
 */
import assert from "node:assert";
import { extractAppFields } from "../lib/forms/application-upsert";

function run() {
  // --- Owner step: owner_full_name → owner_name + contact_name; owner_cell → phone ---
  const owner = extractAppFields({
    owner_full_name: "Jane Q. Merchant",
    owner_ssn: "123-45-6789",
    owner_dob: "1985-04-12",
    owner_cell: "555-867-5309",
    owner_ownership_pct: "100",
    owner_home_address: "1 Main St, Miami FL",
  });
  assert.equal(owner.owner_full_name, "Jane Q. Merchant", "owner_full_name persisted (raw)");
  assert.equal(owner.owner_name, "Jane Q. Merchant", "owner_name aliased from owner_full_name");
  assert.equal(owner.contact_name, "Jane Q. Merchant", "contact_name aliased from owner_full_name");
  assert.equal(owner.phone, "555-867-5309", "phone aliased from owner_cell");
  assert.equal(owner.owner_cell, "555-867-5309", "owner_cell persisted (raw)");
  assert.equal(owner.owner_ssn, "123-45-6789", "owner_ssn persisted");
  assert.equal(owner.owner_dob, "1985-04-12", "owner_dob persisted");
  assert.equal(owner.owner_home_address, "1 Main St, Miami FL", "owner_home_address persisted");
  assert.strictEqual(owner.owner_ownership_pct, 100, "owner_ownership_pct parsed to number");

  // --- Business step: business_legal_name → business_name; state/industry normalized ---
  const biz = extractAppFields({
    business_legal_name: "Acme Holdings LLC",
    dba: "Acme",
    business_address: "500 Market St",
    tax_id_ein: "12-3456789",
    business_start_date: "2019-06-01",
    entity_type: "llc",
    product_service_description: "Retail goods",
    website: " https://acme.example/products ",
    business_state: "fl",
    industry: "Retail",
  });
  assert.equal(biz.business_legal_name, "Acme Holdings LLC", "business_legal_name persisted (raw)");
  assert.equal(biz.business_name, "Acme Holdings LLC", "business_name aliased from business_legal_name");
  assert.equal(biz.tax_id_ein, "12-3456789", "tax_id_ein persisted");
  assert.equal(biz.business_start_date, "2019-06-01", "business_start_date persisted");
  assert.equal(biz.entity_type, "llc", "entity_type persisted");
  assert.equal(biz.dba, "Acme", "dba persisted");
  assert.equal(biz.business_address, "500 Market St", "business_address persisted");
  assert.equal(biz.product_service_description, "Retail goods", "product_service_description persisted");
  assert.equal(biz.website, "https://acme.example/products", "website persisted and trimmed");
  assert.equal(biz.business_state, "FL", "business_state upper-cased");
  assert.equal(biz.industry, "retail", "industry lower-cased");

  // --- Financial: requested_advance alias → requested_amount; currency parsed ---
  const fin = extractAppFields({
    monthly_revenue: "$80,000",
    requested_advance: "$50,000",
  });
  assert.strictEqual(fin.monthly_revenue, 80000, "monthly_revenue currency parsed");
  assert.strictEqual(fin.requested_amount, 50000, "requested_amount aliased from requested_advance + parsed");

  // --- Partner ownership pct numeric ---
  const partner = extractAppFields({ partner_full_name: "Sam Partner", partner_ownership_pct: "49%" });
  assert.equal(partner.partner_full_name, "Sam Partner", "partner_full_name persisted");
  assert.strictEqual(partner.partner_ownership_pct, 49, "partner_ownership_pct parsed (strips %)");

  // --- File + signature-image keys are NEVER copied onto the application ---
  const withFiles = extractAppFields({
    business_legal_name: "Acme Holdings LLC",
    bank_statements: [{ storage_path: "x" }],
    drivers_license: { storage_path: "y" },
    voided_check: { storage_path: "z" },
    applicant_signature: "data:image/png;base64,AAAA",
  });
  assert.ok(!("bank_statements" in withFiles), "bank_statements excluded");
  assert.ok(!("drivers_license" in withFiles), "drivers_license excluded");
  assert.ok(!("voided_check" in withFiles), "voided_check excluded");
  assert.ok(!("applicant_signature" in withFiles), "applicant_signature excluded");
  assert.equal(withFiles.business_name, "Acme Holdings LLC", "non-file field still mapped alongside files");

  // --- Empty / blank values do not create keys ---
  const blanks = extractAppFields({ owner_full_name: "  ", business_legal_name: "" });
  assert.ok(!("owner_full_name" in blanks), "blank owner_full_name dropped");
  assert.ok(!("owner_name" in blanks), "blank owner alias dropped");
  assert.ok(!("business_name" in blanks), "blank business alias dropped");

  console.log("application-upsert field-mapping tests passed");
}

run();
